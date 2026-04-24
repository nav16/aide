(function () {
  'use strict';

  if (window.__aiFiller) return;
  window.__aiFiller = true;

  // Bail early in tiny sub-frames (payment widgets, tracking pixels, ad slots)
  // so we never inject UI into Stripe Elements, reCAPTCHA, etc.
  if (window !== window.top) {
    const w = window.innerWidth  || document.documentElement.clientWidth  || 0;
    const h = window.innerHeight || document.documentElement.clientHeight || 0;
    if (w < 250 || h < 80) return;
  }

  const FIELD_SELECTOR = [
    'input[type="text"]', 'input[type="email"]', 'input[type="search"]',
    'input[type="url"]', 'input[type="tel"]', 'input[type="number"]',
    'textarea', 'input:not([type])',
    '[contenteditable="true"]', '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]'
  ].join(', ');

  // autocomplete tokens that signal payment / credentials / one-time codes.
  // We never want to AI-generate into these (Stripe Checkout, bank login pages,
  // 2FA inputs). https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
  const SENSITIVE_AUTOCOMPLETE = /\b(cc-|credit-card|card-|current-password|new-password|one-time-code|otp|pin|cvc|cvv)\b/i;

  function isSensitiveField(field) {
    const ac = field.getAttribute('autocomplete');
    if (ac && SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
    const name = field.getAttribute('name') || '';
    const id   = field.id || '';
    // Common naming patterns for card/OTP/password inputs across checkout
    // frameworks and form libraries that don't set autocomplete properly.
    if (/\b(card|cvc|cvv|cardnumber|card_number|securitycode|otp|pin|passcode|password)\b/i.test(name + ' ' + id)) return true;
    return false;
  }


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
      <button class="aif-close" aria-label="Close" type="button">✕</button>
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
      <div class="aif-sel-actions">
        <button class="aif-sel-copy hidden" aria-label="Copy" type="button">⧉</button>
        <button class="aif-sel-close" aria-label="Close" type="button">✕</button>
      </div>
    </div>
    <div class="aif-sel-body"></div>
    <form class="aif-sel-followup hidden">
      <input class="aif-sel-ask" type="text" placeholder="Ask a follow-up…" autocomplete="off">
      <button class="aif-sel-ask-btn" type="submit" aria-label="Ask">↵</button>
    </form>
  `;
  document.body.appendChild(selPopup);
  selPopup.style.display = 'none';

  // ---- State ----

  let activeField = null;
  let generatedText = '';
  let scrollListener = null;
  let lastPrompt = '';
  let hideBtnTimer = null;
  let genReqCounter = 0;
  let currentGenReqId = null;

  // ---- Settings cache ----

  const SETTINGS_KEYS = ['provider', 'model', 'ollamaBaseUrl', 'claudeApiKey', 'openaiApiKey', 'geminiApiKey'];
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
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return false;
    const ce = el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '' || ce === 'plaintext-only') return true;
    // role="textbox" on a non-input element — ARIA widget, treat like
    // contenteditable for insertion (editor handles beforeinput/paste itself).
    return el.getAttribute('role') === 'textbox';
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
    // Abort any in-flight generate so the user isn't stuck waiting for a
    // response they've already dismissed (Escape, click-outside, new field).
    if (currentGenReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelGenerate', reqId: currentGenReqId });
      currentGenReqId = null;
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

  dropdown.querySelector('.aif-close').addEventListener('click', () => {
    hideDropdown();
    hideBtn();
  });

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

    // If the user clicks Generate twice in a row, abort the first. Normally
    // the button is disabled while running, but the Cmd/Ctrl+Enter shortcut
    // can still fire during the in-flight window.
    if (currentGenReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelGenerate', reqId: currentGenReqId });
    }
    const reqId = ++genReqCounter;
    currentGenReqId = reqId;

    const msgPayload = {
      action: 'generate',
      reqId,
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

    chrome.runtime.sendMessage(msgPayload, (response) => {
      if (reqId !== currentGenReqId) return; // superseded or cancelled
      currentGenReqId = null;
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
  });

  dropdown.querySelector('.aif-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      dropdown.querySelector('.aif-generate').click();
    }
  });

  // Dispatch a cancelable beforeinput event. Modern editors (Lexical,
  // ProseMirror v2, Slate) subscribe to this and apply edits via their own
  // models, calling preventDefault() to signal they took ownership. The browser
  // itself never treats synthetic InputEvents as trusted, so if nothing cancels
  // it, the caller must fall back to another insertion path.
  // Returns true if the editor consumed it.
  function dispatchBeforeInput(field, text) {
    let dt = null;
    try {
      dt = new DataTransfer();
      dt.setData('text/plain', text);
    } catch { /* DataTransfer constructor unavailable in some sandboxes */ }
    const ev = new InputEvent('beforeinput', {
      inputType: 'insertReplacementText',
      data: text,
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      composed: true
    });
    return !field.dispatchEvent(ev);
  }

  function insertIntoField(field, text) {
    if (isContentEditable(field)) {
      setTimeout(() => {
        field.focus();
        // Select existing contents so the insert replaces them across every path.
        const sel = window.getSelection();
        const preRange = document.createRange();
        preRange.selectNodeContents(field);
        sel.removeAllRanges();
        sel.addRange(preRange);

        // 1. beforeinput — future-proof replacement for execCommand. Lexical,
        // modern ProseMirror, Slate, and other editors listen for InputEvents
        // with inputType 'insertReplacementText' and will apply the change
        // themselves, then call preventDefault() to signal they handled it.
        if (dispatchBeforeInput(field, text)) return;

        // 2. execCommand — Draft.js, Quill, older TinyMCE, Gmail compose.
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
          // 3. Bare contenteditable with no framework.
          try {
            const range = document.createRange();
            range.selectNodeContents(field);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            const endRange = document.createRange();
            endRange.setStartAfter(node);
            endRange.collapse(true);
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
      if (el.parentElement) {
        el = el.parentElement;
      } else {
        const root = el.getRootNode();
        el = root instanceof ShadowRoot ? root.host : null;
      }
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

    typeEl.textContent = isWord ? 'DEFINE' : 'EXPLAIN';
    bodyEl.textContent = '···';
    bodyEl.className = 'aif-sel-body loading';
    selPopup.dataset.selText = text;
    selPopup.dataset.originalText = text; // anchor for any follow-up turns
    selPopup.dataset.priorAnswer = '';
    copyBtn.classList.add('hidden');
    followupForm.classList.add('hidden');
    followupInput.value = '';

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
        copyBtn.dataset.copyText = response.text;
        copyBtn.classList.remove('hidden');
        selPopup.dataset.priorAnswer = response.text;
        followupForm.classList.remove('hidden');
      }
      positionSelPopup(range);
    });
  }

  const followupForm  = selPopup.querySelector('.aif-sel-followup');
  const followupInput = selPopup.querySelector('.aif-sel-ask');
  let followupReqId = null;

  followupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = followupInput.value.trim();
    if (!question) return;
    sendFollowup(question);
  });

  async function sendFollowup(question) {
    const originalText = selPopup.dataset.originalText || '';
    const prior        = selPopup.dataset.priorAnswer  || '';
    if (!originalText) return;

    const settings = await getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    typeEl.textContent = 'FOLLOW-UP';
    bodyEl.textContent = '···';
    bodyEl.className = 'aif-sel-body loading';
    copyBtn.classList.add('hidden');
    followupInput.disabled = true;

    // Cancel any prior follow-up still in flight.
    if (followupReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelExplain', reqId: followupReqId });
    }
    const myReqId = ++selReqId;
    followupReqId = myReqId;

    chrome.runtime.sendMessage({
      action: 'explain',
      reqId: myReqId,
      kind: 'followup',
      text: question,
      context: { originalText, prior },
      pageTitle: document.title,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl
    }, (response) => {
      if (myReqId !== followupReqId) return; // superseded
      followupReqId = null;
      followupInput.disabled = false;
      if (selPopup.style.display === 'none') return;
      bodyEl.className = 'aif-sel-body';
      if (chrome.runtime.lastError || !response?.success) {
        bodyEl.textContent = response?.error || 'Failed to fetch.';
        bodyEl.className = 'aif-sel-body aif-sel-error';
      } else {
        bodyEl.innerHTML = renderMarkdown(response.text);
        copyBtn.dataset.copyText = response.text;
        copyBtn.classList.remove('hidden');
        // Chain into prior answer so the next follow-up sees this turn too.
        selPopup.dataset.priorAnswer = response.text;
        followupInput.value = '';
        followupInput.focus();
      }
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // navigator.clipboard can be blocked on non-secure contexts or by CSP;
      // fall back to the legacy textarea+execCommand path.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  const copyBtn = selPopup.querySelector('.aif-sel-copy');
  copyBtn.addEventListener('click', async () => {
    const text = copyBtn.dataset.copyText || selPopup.querySelector('.aif-sel-body').textContent;
    if (!text) return;
    const ok = await copyText(text);
    const prev = copyBtn.textContent;
    copyBtn.textContent = ok ? '✓' : '✕';
    setTimeout(() => { copyBtn.textContent = prev; }, 900);
  });

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

  // WeakSet instead of a DOM dataset flag: React/Vue/etc. can re-render from
  // state and strip custom dataset attrs, which would make us re-attach
  // listeners on every re-render. A WeakSet keyed by the element survives
  // re-renders without mutating the DOM, and the entry GCs when the node
  // itself is collected.
  const attachedFields = new WeakSet();

  function attach(field) {
    if (attachedFields.has(field)) return;
    if (dropdown.contains(field) || field === btn) return; // never instrument our own UI
    if ((field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') &&
        (field.readOnly || field.disabled)) return;
    if (isSensitiveField(field)) return;
    // For contenteditable: attach only to the innermost editable node —
    // the one with no contenteditable children. Outer wrappers (Draft.js root,
    // Quill container, etc.) delegate editing to an inner node; targeting them
    // causes Range ops to corrupt the editor's internal DOM structure.
    if (isContentEditable(field)) {
      let innerEditable = false;
      walkRoots(field, r => {
        if (innerEditable) return;
        if (r === field) return;
        if (r.querySelector?.('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]')) innerEditable = true;
      });
      if (innerEditable) return;
    }

    attachedFields.add(field);
    field.addEventListener('focus', onFocus);
    field.addEventListener('blur', onBlur);
  }

  // Pierce shadow DOM: visit node + every shadow root reachable through descendants.
  // Native querySelectorAll stops at shadow boundaries; many apps (Salesforce,
  // YouTube chrome, design-system widgets) render form fields inside shadow trees.
  function walkRoots(node, visit) {
    visit(node);
    if (node.shadowRoot) walkRoots(node.shadowRoot, visit);
    const all = node.querySelectorAll ? node.querySelectorAll('*') : null;
    if (!all) return;
    for (const el of all) if (el.shadowRoot) walkRoots(el.shadowRoot, visit);
  }

  const observedShadowRoots = new WeakSet();

  function scanAndObserve(node) {
    if (node.nodeType === 1 && node.matches?.(FIELD_SELECTOR)) attach(node);
    walkRoots(node, r => {
      r.querySelectorAll?.(FIELD_SELECTOR).forEach(attach);
      if (r instanceof ShadowRoot && !observedShadowRoots.has(r)) {
        observedShadowRoots.add(r);
        new MutationObserver(onMutations).observe(r, { childList: true, subtree: true });
      }
    });
  }

  // Coalesce mutations into a small Set so that very chatty pages (Gmail,
  // Twitter, Notion) don't make us walk every addedNode subtree synchronously.
  // We wait for idle (or a 50ms deadline) and process unique nodes once.
  const pendingNodes = new Set();
  let flushHandle = null;
  const schedule = typeof requestIdleCallback === 'function'
    ? cb => requestIdleCallback(cb, { timeout: 200 })
    : cb => setTimeout(cb, 50);

  function flushPending() {
    flushHandle = null;
    if (pendingNodes.size === 0) return;
    const nodes = Array.from(pendingNodes);
    pendingNodes.clear();
    for (const node of nodes) {
      if (!node.isConnected) continue;
      scanAndObserve(node);
    }
  }

  function onMutations(muts) {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        pendingNodes.add(node);
      }
    }
    if (flushHandle === null) flushHandle = schedule(flushPending);
  }

  scanAndObserve(document.body);
  new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
})();
