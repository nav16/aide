(function () {
  'use strict';

  if (window.__aiFiller) return;
  window.__aiFiller = true;

  const FIELD_SELECTOR = [
    'input[type="text"]', 'input[type="email"]', 'input[type="search"]',
    'input[type="url"]', 'input[type="tel"]', 'input[type="number"]',
    'input[type="password"]', 'textarea', 'input:not([type])',
    '[contenteditable="true"]', '[contenteditable=""]'
  ].join(', ');

  // ---- DOM setup ----

  const btn = document.createElement('button');
  btn.className = 'aif-btn';
  btn.setAttribute('aria-label', 'AI Fill');
  btn.textContent = '✨';
  document.body.appendChild(btn);

  const dropdown = document.createElement('div');
  dropdown.className = 'aif-dropdown';
  dropdown.innerHTML = `
    <div class="aif-header">
      <span class="aif-label-text"></span>
      <span class="aif-badge"></span>
    </div>
    <textarea class="aif-prompt" rows="2" placeholder="Describe what to generate (optional)…"></textarea>
    <button class="aif-generate">Generate</button>
    <div class="aif-result"></div>
  `;
  document.body.appendChild(dropdown);

  const selPopup = document.createElement('div');
  selPopup.className = 'aif-sel-popup';
  selPopup.innerHTML = `
    <div class="aif-sel-header">
      <span class="aif-sel-type"></span>
      <button class="aif-sel-close" aria-label="Close">✕</button>
    </div>
    <div class="aif-sel-body"></div>
  `;
  document.body.appendChild(selPopup);
  selPopup.style.display = 'none';

  // ---- State ----

  let activeField = null;
  let generatedText = '';
  let scrollListener = null;
  let lastPrompt = '';
  let hideBtnTimer = null;
  let activeGenerateController = null;
  let activeExplainController = null;

  // ---- Settings cache ----

  const SETTINGS_KEYS = ['provider', 'model', 'ollamaBaseUrl', 'claudeApiKey', 'openaiApiKey', 'geminiApiKey', 'streamingEnabled'];
  let cachedSettings = null;

  function getSettings() {
    if (cachedSettings) return Promise.resolve(cachedSettings);
    return new Promise(r => chrome.storage.sync.get(SETTINGS_KEYS, data => {
      cachedSettings = data;
      r(data);
    }));
  }

  chrome.storage.onChanged.addListener(() => { cachedSettings = null; });

  hideDropdown();
  hideBtn();

  // ---- Helpers ----

  function isContentEditable(el) {
    const ce = el.getAttribute('contenteditable');
    return ce === 'true' || ce === '';
  }

  // ---- Label extraction ----

  function extractLabel(field) {
    if (field.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const ariaLabel = field.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = field.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.trim().split(/\s+/);
      const text = ids.map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
      if (text) return text;
    }

    const parentLabel = field.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach(e => e.remove());
      const t = clone.textContent.trim();
      if (t) return t;
    }

    // data-placeholder used by some rich-text editors (e.g. Notion, Slack)
    const dataPlaceholder = field.getAttribute('data-placeholder') || field.getAttribute('placeholder');
    if (dataPlaceholder) return dataPlaceholder.trim();

    if (field.name) return humanizeName(field.name);

    // Look for nearby heading / label text above the field
    const prev = field.previousElementSibling;
    if (prev && /^(label|span|p|div|h\d)$/i.test(prev.tagName)) {
      const t = prev.textContent.trim();
      if (t && t.length < 80) return t;
    }

    return 'this field';
  }

  function extractConstraints(field) {
    const c = {};
    // Standard maxlength/minlength (works on input, textarea)
    if (field.maxLength > 0) c.maxChars = field.maxLength;
    else {
      const max = parseInt(field.getAttribute('maxlength') || field.getAttribute('data-maxlength'), 10);
      if (max > 0) c.maxChars = max;
    }
    if (field.minLength > 0) c.minChars = field.minLength;
    return c;
  }

  function humanizeName(name) {
    return name
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_\-.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\w/, c => c.toUpperCase());
  }

  // ---- Direct streaming (content script fetch — no service worker buffering) ----

  const FORM_SYSTEM = 'You are a form-filling assistant. Output ONLY the value to insert into the field — no explanation, no preamble, no quotes, no markdown unless formatting is expected.';
  const STREAM_MAX_TOKENS = { form: 256, explain: 512 };

  function buildUserMsg(label, constraints, prompt, pageTitle) {
    let msg = `Page: "${pageTitle}"\nField: "${label}"\n`;
    if (constraints?.maxChars) msg += `Max characters: ${constraints.maxChars}\n`;
    if (constraints?.minChars) msg += `Min characters: ${constraints.minChars}\n`;
    msg += prompt ? `Instruction: ${prompt}` : 'Generate appropriate content for this field.';
    return msg;
  }

  function buildExplainPrompts(kind, text, pageTitle) {
    return {
      system: kind === 'word'
        ? 'You are a concise dictionary. Given a word, respond with: part of speech, definition (1-2 sentences), and a short example sentence. No preamble.'
        : 'You are a helpful explainer. Given selected text, explain it clearly in 2-3 sentences for a general audience. No preamble.',
      user: kind === 'word'
        ? `Word: "${text}"\nPage context: "${pageTitle}"`
        : `Text: "${text}"\nPage context: "${pageTitle}"`
    };
  }

  async function* readSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const d = line.slice(6).trim();
            if (d !== '[DONE]') yield d;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function* streamText(settings, userContent, systemPrompt, maxTokens, signal) {
    const { provider, model, ollamaBaseUrl } = settings;
    const apiKey = settings[`${provider}ApiKey`] || '';

    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          stream: true,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }]
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Claude API error ${res.status}`);
      }
      for await (const data of readSSE(res)) {
        if (signal?.aborted) return;
        try {
          const p = JSON.parse(data);
          if (p.type === 'content_block_delta' && p.delta?.type === 'text_delta' && p.delta.text) {
            yield p.delta.text;
          }
        } catch {}
      }

    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || 'gpt-4o',
          max_tokens: maxTokens,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContent }
          ]
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `OpenAI API error ${res.status}`);
      }
      for await (const data of readSSE(res)) {
        if (signal?.aborted) return;
        try {
          const p = JSON.parse(data);
          const text = p.choices?.[0]?.delta?.content;
          if (text) yield text;
        } catch {}
      }

    } else if (provider === 'ollama') {
      const base = (ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContent }
          ]
        })
      });
      if (res.status === 403) throw new Error('Ollama blocked (403). Restart with OLLAMA_ORIGINS="*"');
      if (!res.ok) throw new Error(`Ollama error ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          if (signal?.aborted) return;
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line);
              if (p.message?.content) yield p.message.content;
              if (p.done) return;
            } catch {}
          }
        }
      } finally {
        reader.releaseLock();
      }

    } else if (provider === 'gemini') {
      // Gemini streaming format is complex; single-shot, yield full response as one chunk
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3-flash-preview'}:generateContent?key=${apiKey}`,
        {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userContent }] }]
          })
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Gemini API error ${res.status}`);
      }
      const data = await res.json();
      yield data.candidates[0].content.parts[0].text.trim();

    } else {
      throw new Error('Unknown provider. Configure settings.');
    }
  }

  // ---- Positioning ----

  function positionBtn(field) {
    const r = field.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // For tall fields (textareas, editors), pin button near top-right; otherwise center vertically
    const btnH = 22;
    const top = r.height > 50 ? r.top + 8 : r.top + (r.height - btnH) / 2;
    btn.style.top = `${top}px`;
    btn.style.left = `${r.right - 30}px`;
    btn.style.display = 'flex';
  }

  function positionDropdown(field) {
    const r = field.getBoundingClientRect();
    let top = r.bottom + 4;
    let left = r.left;
    // Keep dropdown inside viewport horizontally
    if (left + 290 > window.innerWidth) left = Math.max(4, window.innerWidth - 294);
    // Flip above field if not enough space below
    if (top + 260 > window.innerHeight) top = r.top - 264;
    dropdown.style.top = `${top}px`;
    dropdown.style.left = `${left}px`;
  }

  function hideBtn() { btn.style.display = 'none'; }

  function hideDropdown() {
    dropdown.style.display = 'none';
    generatedText = '';
    if (scrollListener) {
      window.removeEventListener('scroll', scrollListener, true);
      scrollListener = null;
    }
    if (activeGenerateController) {
      activeGenerateController.abort();
      activeGenerateController = null;
    }
  }

  // ---- Show dropdown ----

  function openDropdown(field) {
    const label = extractLabel(field);
    const constraints = extractConstraints(field);
    const labelText = constraints.maxChars
      ? `Field: ${label} · ${constraints.maxChars} chars max`
      : `Field: ${label}`;
    dropdown.querySelector('.aif-label-text').textContent = labelText;
    dropdown.querySelector('.aif-result').textContent = '';
    dropdown.querySelector('.aif-result').className = 'aif-result';
    dropdown.querySelector('.aif-result').style.display = 'none';
    const genBtn = dropdown.querySelector('.aif-generate');
    genBtn.disabled = false;
    genBtn.textContent = 'Generate';
    genBtn.classList.remove('loading');
    // restore last prompt with text selected so user can overwrite easily
    const promptEl = dropdown.querySelector('.aif-prompt');
    promptEl.value = lastPrompt;
    requestAnimationFrame(() => {
      promptEl.focus();
      if (lastPrompt) promptEl.select();
    });

    getSettings().then(d => {
      const labels = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama' };
      dropdown.querySelector('.aif-badge').textContent = labels[d.provider] || '⚙ Not configured';
    });

    dropdown.style.display = 'block';
    positionDropdown(field);

    scrollListener = () => positionDropdown(field);
    window.addEventListener('scroll', scrollListener, { passive: true, capture: true });
  }

  // ---- Field events ----

  function onFocus(e) {
    if (dropdown.contains(e.target) || e.target === btn) return; // ignore our own UI
    clearTimeout(hideBtnTimer); // cancel any pending hide from a prior blur
    activeField = e.target;
    positionBtn(activeField);
  }

  function onBlur() {
    hideBtnTimer = setTimeout(() => {
      if (document.activeElement !== btn && !dropdown.contains(document.activeElement)) {
        hideBtn();
      }
    }, 200);
  }

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // prevents field losing focus/selection
    if (activeField) openDropdown(activeField);
  });

  // ---- Generate ----

  dropdown.querySelector('.aif-generate').addEventListener('click', async () => {
    if (!activeField) return;

    const settings = await getSettings();

    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    if (!settings.provider) {
      return showError('Open extension settings and configure a provider first.');
    }
    if (settings.provider !== 'ollama' && !apiKey) {
      return showError('API key not set. Open extension popup to configure.');
    }

    const genBtn   = dropdown.querySelector('.aif-generate');
    const promptEl = dropdown.querySelector('.aif-prompt');
    lastPrompt = promptEl.value.trim();

    genBtn.disabled = true;
    genBtn.textContent = '· · ·';
    genBtn.classList.add('loading');

    const resultEl = dropdown.querySelector('.aif-result');
    resultEl.className = 'aif-result';
    resultEl.style.display = 'none';

    const msgPayload = {
      action: 'generate',
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl,
      label: extractLabel(activeField),
      constraints: extractConstraints(activeField),
      prompt: lastPrompt,
      pageTitle: document.title
    };

    const resetBtn = () => {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate';
      genBtn.classList.remove('loading');
    };

    if (settings.streamingEnabled) {
      const controller = new AbortController();
      activeGenerateController = controller;
      let accumulated = '';
      const userContent = buildUserMsg(
        msgPayload.label, msgPayload.constraints, lastPrompt, document.title
      );
      try {
        const gen = streamText(settings, userContent, FORM_SYSTEM, STREAM_MAX_TOKENS.form, controller.signal);
        for await (const chunk of gen) {
          accumulated += chunk;
          resultEl.textContent = accumulated;
          resultEl.style.display = 'block';
          await new Promise(r => requestAnimationFrame(r));
        }
        activeGenerateController = null;
        resetBtn();
        const field = activeField;
        hideDropdown();
        hideBtn();
        insertIntoField(field, accumulated.trim());
      } catch (err) {
        activeGenerateController = null;
        if (err.name !== 'AbortError') showError(err.message || 'Generation failed.');
        else resetBtn();
      }
    } else {
      chrome.runtime.sendMessage(msgPayload, (response) => {
        resetBtn();
        if (chrome.runtime.lastError) {
          return showError('Extension error. Reload the page and try again.');
        }
        if (response?.success) {
          const field = activeField;
          hideDropdown();
          hideBtn();
          insertIntoField(field, response.text);
        } else {
          showError(response?.error || 'Generation failed.');
        }
      });
    }
  });

  dropdown.querySelector('.aif-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      dropdown.querySelector('.aif-generate').click();
    }
  });

  function insertIntoField(field, text) {
    if (isContentEditable(field)) {
      setTimeout(() => {
        field.focus();
        // execCommand is what Draft.js/Slate/Quill/ProseMirror all expect —
        // they intercept browser editing events, not DOM mutations.
        // Must run after focus() is settled, which is why this is inside setTimeout.
        let ok = false;
        const hasNewlines = text.includes('\n');
        if (!hasNewlines) {
          // Single-line: selectAll + insertText replaces selection in one shot.
          // Skipping the intermediate delete keeps the editor's internal model in sync
          // (React/custom editors like Twitter update state via beforeinput on insertText,
          // but may ignore the delete step and retain the original text when serializing).
          document.execCommand('selectAll', false, null);
          ok = document.execCommand('insertText', false, text);
        } else {
          // Multi-line: delete first then insert line-by-line — inserting full text with \n
          // in one execCommand loses newlines in rich-text editors like Gmail.
          const cleared = document.execCommand('selectAll', false, null) &&
                          document.execCommand('delete', false, null);
          ok = cleared;
          if (cleared) {
            const lines = text.split('\n');
            lines.forEach((line, i) => {
              if (i > 0) document.execCommand('insertParagraph', false, null);
              if (line) ok = document.execCommand('insertText', false, line) && ok;
            });
          }
        }
        if (!ok) {
          // Fallback: bare contenteditable with no framework
          try {
            const range = document.createRange();
            range.selectNodeContents(field);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            const endRange = document.createRange();
            endRange.setStartAfter(node);
            endRange.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(endRange);
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          } catch (e) {
            field.textContent = text;
            field.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
        }
      }, 50);
    } else {
      const proto = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(field, text);
      else field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
  }


  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dropdown.style.display !== 'none') hideDropdown();
      if (selPopup.style.display !== 'none') hideSelPopup();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (dropdown.style.display === 'none') return;
    if (!dropdown.contains(e.target) && e.target !== btn) hideDropdown();
  });

  document.addEventListener('mousedown', (e) => {
    if (selPopup.style.display === 'none') return;
    if (!selPopup.contains(e.target)) {
      // only dismiss immediately if not starting a new selection (single click, not drag)
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hideSelPopup();
      }, 10);
    }
  });

  // ---- Selection popup ----

  selPopup.querySelector('.aif-sel-close').addEventListener('click', hideSelPopup);

  function hideSelPopup() {
    selPopup.style.display = 'none';
    if (activeExplainController) {
      activeExplainController.abort();
      activeExplainController = null;
    }
  }

  let selDebounce = null;
  let selReqId = 0;
  let lastSentReqId = null;

  document.addEventListener('selectionchange', () => {
    clearTimeout(selDebounce);
    selDebounce = setTimeout(() => checkSelection(), 300);
  });

  function isInsideEditableField(node) {
    let el = node.nodeType === 3 ? node.parentElement : node;
    while (el) {
      if (el.matches?.(FIELD_SELECTOR)) return true;
      el = el.parentElement;
    }
    return false;
  }

  async function checkSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideSelPopup(); return; }
    const text = sel.toString().trim();
    if (!text || text.length < 2) { hideSelPopup(); return; }

    const range = sel.getRangeAt(0);
    if (isInsideEditableField(range.commonAncestorContainer)) { hideSelPopup(); return; }

    const isWord = /^\S+$/.test(text) && text.length < 40;
    const kind   = isWord ? 'word' : 'explain';

    const bodyEl = selPopup.querySelector('.aif-sel-body');
    const typeEl = selPopup.querySelector('.aif-sel-type');

    // same text already showing — no need to re-fetch
    if (selPopup.style.display === 'block' && selPopup.dataset.selText === text) {
      positionSelPopup(range);
      return;
    }

    selReqId++;
    const myReqId = selReqId;

    if (lastSentReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelExplain', reqId: lastSentReqId });
    }
    if (activeExplainController) {
      activeExplainController.abort();
      activeExplainController = null;
    }

    typeEl.textContent = isWord ? 'DEFINE' : 'EXPLAIN';
    bodyEl.textContent = '···';
    bodyEl.className = 'aif-sel-body loading';
    selPopup.dataset.selText = text;

    positionSelPopup(range);
    selPopup.style.display = 'block';

    const settings = await getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    const explainPayload = {
      action: 'explain',
      kind,
      text,
      pageTitle: document.title,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl
    };

    if (settings.streamingEnabled) {
      const controller = new AbortController();
      activeExplainController = controller;
      const { system, user } = buildExplainPrompts(kind, text, document.title);
      let accumulated = '';
      try {
        const gen = streamText(settings, user, system, STREAM_MAX_TOKENS.explain, controller.signal);
        for await (const chunk of gen) {
          if (myReqId !== selReqId || selPopup.style.display === 'none') {
            controller.abort();
            return;
          }
          accumulated += chunk;
          bodyEl.className = 'aif-sel-body';
          bodyEl.innerHTML = renderMarkdown(accumulated);
          positionSelPopup(range);
          await new Promise(r => requestAnimationFrame(r));
        }
        activeExplainController = null;
      } catch (err) {
        activeExplainController = null;
        if (err.name === 'AbortError') return;
        if (myReqId !== selReqId || selPopup.style.display === 'none') return;
        bodyEl.textContent = err.message || 'Failed to fetch.';
        bodyEl.className = 'aif-sel-body aif-sel-error';
        positionSelPopup(range);
      }
    } else {
      lastSentReqId = myReqId;
      chrome.runtime.sendMessage({ ...explainPayload, reqId: myReqId }, (response) => {
        if (myReqId === lastSentReqId) lastSentReqId = null;
        if (myReqId !== selReqId) return; // superseded by newer selection
        if (selPopup.style.display === 'none') return;
        bodyEl.className = 'aif-sel-body';
        if (chrome.runtime.lastError || !response?.success) {
          bodyEl.textContent = response?.error || 'Failed to fetch.';
          bodyEl.className = 'aif-sel-body aif-sel-error';
        } else {
          bodyEl.innerHTML = renderMarkdown(response.text);
        }
        positionSelPopup(range);
      });
    }
  }

  function renderMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function positionSelPopup(range) {
    const r = range.getBoundingClientRect();
    const popW = 280;
    const popH = selPopup.offsetHeight || 120;
    let left = r.left + (r.width / 2) - (popW / 2);
    if (left < 6) left = 6;
    if (left + popW > window.innerWidth - 6) left = window.innerWidth - popW - 6;
    let top = r.top - popH - 10;
    if (top < 6) top = r.bottom + 10;
    selPopup.style.left = `${left}px`;
    selPopup.style.top  = `${top}px`;
  }

  function showError(msg) {
    const genBtn   = dropdown.querySelector('.aif-generate');
    const resultEl = dropdown.querySelector('.aif-result');
    genBtn.disabled = false;
    genBtn.textContent = 'Generate';
    genBtn.classList.remove('loading');
    resultEl.className = 'aif-result aif-error';
    resultEl.textContent = msg;
    resultEl.style.display = 'block';
  }

  // ---- Field instrumentation ----

  function attach(field) {
    if (field.dataset.aifAttached) return;
    if (dropdown.contains(field) || field === btn) return; // never instrument our own UI
    if ((field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') &&
        (field.readOnly || field.disabled)) return;
    // For contenteditable: attach only to the innermost editable node —
    // the one with no contenteditable children. Outer wrappers (Draft.js root,
    // Quill container, etc.) delegate editing to an inner node; targeting them
    // causes Range ops to corrupt the editor's internal DOM structure.
    if (isContentEditable(field)) {
      if (field.querySelector('[contenteditable="true"], [contenteditable=""]')) return;
    }

    field.dataset.aifAttached = '1';
    field.addEventListener('focus', onFocus);
    field.addEventListener('blur', onBlur);
  }

  function attachAll() {
    document.querySelectorAll(FIELD_SELECTOR).forEach(attach);
  }

  attachAll();

  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(FIELD_SELECTOR)) attach(node);
        node.querySelectorAll?.(FIELD_SELECTOR).forEach(attach);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
