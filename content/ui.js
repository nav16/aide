(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // ---- DOM setup ----

  const btn = document.createElement('button');
  btn.className = 'aif-btn';
  btn.setAttribute('aria-label', 'AI Fill');
  btn.textContent = '✨';
  btn.style.display = 'none';
  document.body.appendChild(btn);
  A.btn = btn;

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
  dropdown.style.display = 'none';
  document.body.appendChild(dropdown);
  A.dropdown = dropdown;

  // ---- State owned by the dropdown flow ----

  A.activeField    = null;
  A.lastPrompt     = '';
  A.scrollListener = null;

  // ---- Positioning ----

  A.positionBtn = function (field) {
    const r = field.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // For tall fields (textareas, editors), pin button near top-right; otherwise center vertically
    const btnH = 22;
    const top = r.height > 50 ? r.top + 8 : r.top + (r.height - btnH) / 2;
    btn.style.top = `${top}px`;
    btn.style.left = `${r.right - 30}px`;
    btn.style.display = 'flex';
  };

  A.positionDropdown = function (field) {
    const r = field.getBoundingClientRect();
    let top = r.bottom + 4;
    let left = r.left;
    // Keep dropdown inside viewport horizontally
    if (left + 290 > window.innerWidth) left = Math.max(4, window.innerWidth - 294);
    // Flip above field if not enough space below
    if (top + 260 > window.innerHeight) top = r.top - 264;
    dropdown.style.top = `${top}px`;
    dropdown.style.left = `${left}px`;
  };

  A.hideBtn = function () { btn.style.display = 'none'; };

  A.hideDropdown = function () {
    dropdown.style.display = 'none';
    if (A.scrollListener) {
      window.removeEventListener('scroll', A.scrollListener, true);
      A.scrollListener = null;
    }
    // Abort any in-flight generate so the user isn't stuck waiting for a
    // response they've already dismissed (Escape, click-outside, new field).
    if (A.currentGenReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelGenerate', reqId: A.currentGenReqId });
      A.currentGenReqId = null;
    }
  };

  A.openDropdown = function (field) {
    const ctx = A.extractFieldContext(field);
    const labelText = ctx.maxChars
      ? `Field: ${ctx.label} · ${ctx.maxChars} chars max`
      : `Field: ${ctx.label}`;
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
    promptEl.value = A.lastPrompt;
    requestAnimationFrame(() => {
      promptEl.focus();
      if (A.lastPrompt) promptEl.select();
    });

    A.getSettings().then(d => {
      const labels = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama' };
      dropdown.querySelector('.aif-badge').textContent = labels[d.provider] || '⚙ Not configured';
    });

    dropdown.style.display = 'block';
    A.positionDropdown(field);

    // Capture-phase scroll fires for every scrollable ancestor, on every tick.
    // Coalesce repositioning into a single rAF per frame so getBoundingClientRect
    // (which forces layout) runs at most ~60Hz instead of per scroll event.
    let rafPending = false;
    A.scrollListener = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        A.positionDropdown(field);
      });
    };
    window.addEventListener('scroll', A.scrollListener, { passive: true, capture: true });
  };

  A.showError = function (msg) {
    const genBtn   = dropdown.querySelector('.aif-generate');
    const resultEl = dropdown.querySelector('.aif-result');
    genBtn.disabled = false;
    genBtn.textContent = 'Generate';
    genBtn.classList.remove('loading');
    resultEl.className = 'aif-result aif-error';
    resultEl.textContent = msg;
    resultEl.style.display = 'block';
  };

  // ---- Wiring ----

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // prevents field losing focus/selection
    if (A.activeField) A.openDropdown(A.activeField);
  });

  dropdown.querySelector('.aif-close').addEventListener('click', () => {
    A.hideDropdown();
    A.hideBtn();
  });

  dropdown.querySelector('.aif-generate').addEventListener('click', async () => {
    if (!A.activeField) return;

    const settings = await A.getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    if (!settings.provider) {
      return A.showError('Open extension settings and configure a provider first.');
    }
    if (settings.provider !== 'ollama' && !apiKey) {
      return A.showError('API key not set. Open extension popup to configure.');
    }

    const genBtn   = dropdown.querySelector('.aif-generate');
    const promptEl = dropdown.querySelector('.aif-prompt');
    A.lastPrompt = promptEl.value.trim();

    genBtn.disabled = true;
    genBtn.textContent = '· · ·';
    genBtn.classList.add('loading');

    const resultEl = dropdown.querySelector('.aif-result');
    resultEl.className = 'aif-result';
    resultEl.style.display = 'none';

    // If the user clicks Generate twice in a row, abort the first. Normally
    // the button is disabled while running, but the Cmd/Ctrl+Enter shortcut
    // can still fire during the in-flight window.
    if (A.currentGenReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelGenerate', reqId: A.currentGenReqId });
    }
    const reqId = ++A.genReqCounter;
    A.currentGenReqId = reqId;

    const msgPayload = {
      action: 'generate',
      reqId,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl,
      fieldContext: A.extractFieldContext(A.activeField),
      prompt: A.lastPrompt,
      pageTitle: document.title,
      userProfile: settings.userProfile || ''
    };

    const resetBtn = () => {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate';
      genBtn.classList.remove('loading');
    };

    chrome.runtime.sendMessage(msgPayload, (response) => {
      if (reqId !== A.currentGenReqId) return; // superseded or cancelled
      A.currentGenReqId = null;
      resetBtn();
      if (chrome.runtime.lastError) {
        return A.showError('Extension error. Reload the page and try again.');
      }
      if (response?.success) {
        const field = A.activeField;
        A.hideDropdown();
        A.hideBtn();
        A.insertIntoField(field, response.text);
      } else {
        A.showError(response?.error || 'Generation failed.');
      }
    });
  });

  dropdown.querySelector('.aif-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      dropdown.querySelector('.aif-generate').click();
    }
  });
})();
