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

  // ---- State ----

  let activeField = null;
  let generatedText = '';
  let scrollListener = null;
  let lastPrompt = '';

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
  }

  // ---- Show dropdown ----

  function openDropdown(field) {
    const label = extractLabel(field);
    dropdown.querySelector('.aif-label-text').textContent = `Field: ${label}`;
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

    chrome.storage.sync.get(['provider'], (d) => {
      const labels = { claude: 'Claude', openai: 'OpenAI', ollama: 'Ollama' };
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
    activeField = e.target;
    positionBtn(activeField);
  }

  function onBlur() {
    setTimeout(() => {
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

    const settings = await new Promise(r => {
      chrome.storage.sync.get(['provider', 'apiKey', 'model', 'ollamaBaseUrl'], r);
    });

    if (!settings.provider) {
      return showError('Open extension settings and configure a provider first.');
    }
    if (settings.provider !== 'ollama' && !settings.apiKey) {
      return showError('API key not set. Open extension popup to configure.');
    }

    const genBtn   = dropdown.querySelector('.aif-generate');
    const promptEl = dropdown.querySelector('.aif-prompt');
    lastPrompt = promptEl.value.trim();

    genBtn.disabled = true;
    genBtn.textContent = '· · ·';
    genBtn.classList.add('loading');
    dropdown.querySelector('.aif-result').style.display = 'none';

    chrome.runtime.sendMessage({
      action: 'generate',
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl,
      label: extractLabel(activeField),
      prompt: lastPrompt,
      pageTitle: document.title
    }, (response) => {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate';
      genBtn.classList.remove('loading');

      if (chrome.runtime.lastError) {
        return showError('Extension error. Reload the page and try again.');
      }
      if (response?.success) {
        const field = activeField;
        const text  = response.text;
        hideDropdown();
        hideBtn();
        insertIntoField(field, text);
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

  function insertIntoField(field, text) {
    if (isContentEditable(field)) {
      setTimeout(() => {
        field.focus();
        // execCommand is what Draft.js/Slate/Quill/ProseMirror all expect —
        // they intercept browser editing events, not DOM mutations.
        // Must run after focus() is settled, which is why this is inside setTimeout.
        const ok = document.execCommand('selectAll', false, null) &&
                   document.execCommand('insertText', false, text);
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
      try {
        field.setRangeText(text, 0, field.value.length, 'end');
      } catch (e) {
        const proto = field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(field, text);
        else field.value = text;
      }
      field.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
  }


  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dropdown.style.display !== 'none') hideDropdown();
  });

  document.addEventListener('mousedown', (e) => {
    if (dropdown.style.display === 'none') return;
    if (!dropdown.contains(e.target) && e.target !== btn) hideDropdown();
  });

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
