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
    <button class="aif-fillform" type="button">Fill entire form</button>
    <div class="aif-result"></div>
    <div class="aif-ff-panel" style="display:none">
      <div class="aif-ff-list"></div>
      <div class="aif-ff-actions">
        <button class="aif-ff-cancel" type="button">Cancel</button>
        <button class="aif-ff-apply"  type="button">Apply</button>
      </div>
    </div>
  `;
  dropdown.style.display = 'none';
  document.body.appendChild(dropdown);
  A.dropdown = dropdown;

  // ---- State owned by the dropdown flow ----

  A.activeField    = null;
  A.lastPrompt     = '';
  A.scrollListener = null;
  // Fill-form state. fieldMap routes returned keys back to live elements.
  // snapshots holds prior values so the undo toast can revert in one click.
  A.ffState = null;
  A.ffReqId = null;

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setComposeMode() {
    dropdown.querySelector('.aif-header').style.display    = '';
    dropdown.querySelector('.aif-prompt').style.display    = '';
    dropdown.querySelector('.aif-generate').style.display  = '';
    // ffBtn visibility tracks the popup toggle; settings are cached after
    // the first openDropdown so this read is synchronous in steady state.
    const ffEnabled = !!(A.cachedSettings?.fillFormEnabled);
    dropdown.querySelector('.aif-fillform').style.display  = ffEnabled ? '' : 'none';
    dropdown.querySelector('.aif-ff-panel').style.display  = 'none';
  }

  function setPreviewMode() {
    // Header describes the anchor field — irrelevant when previewing values
    // for the entire form. Hide compose UI + header, show only the preview.
    dropdown.querySelector('.aif-header').style.display    = 'none';
    dropdown.querySelector('.aif-prompt').style.display    = 'none';
    dropdown.querySelector('.aif-generate').style.display  = 'none';
    dropdown.querySelector('.aif-fillform').style.display  = 'none';
    dropdown.querySelector('.aif-result').style.display    = 'none';
    dropdown.querySelector('.aif-ff-panel').style.display  = '';
  }

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
    if (A.ffReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelFillForm', reqId: A.ffReqId });
      A.ffReqId = null;
    }
    A.ffState = null;
    setComposeMode();
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
      // Fill-form is gated by an explicit user toggle in the popup. Hide the
      // button entirely when off so it doesn't take visual space; show it
      // when enabled.
      const ffBtn = dropdown.querySelector('.aif-fillform');
      ffBtn.style.display = d.fillFormEnabled ? '' : 'none';
      ffBtn.disabled = false;
      ffBtn.title = '';
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

  // ---- Fill entire form ----

  function buildDescriptors(fields) {
    return fields.map((f, i) => {
      const ctx = A.extractFieldContext(f);
      // hostname is per-page, not per-field — drop from the descriptor and
      // pass once at the request level.
      delete ctx.hostname;
      return { key: 'f' + i, ...ctx };
    });
  }

  function renderFFList() {
    if (!A.ffState) return;
    const list = dropdown.querySelector('.aif-ff-list');
    const rows = A.ffState.fills.map(f => {
      const desc = A.ffState.descriptors.find(d => d.key === f.key);
      const label = desc?.label || f.key;
      const max = desc?.maxChars ? ` data-max="${desc.maxChars}"` : '';
      return `
        <div class="aif-ff-row" data-key="${escapeHtml(f.key)}">
          <div class="aif-ff-label">${escapeHtml(label)}</div>
          <input class="aif-ff-input" type="text" value="${escapeHtml(f.value || '')}"${max} placeholder="— skip —">
        </div>`;
    }).join('');
    list.innerHTML = rows || '<div class="aif-ff-empty">No fields returned.</div>';
  }

  dropdown.querySelector('.aif-fillform').addEventListener('click', async () => {
    if (!A.activeField) return;

    const settings = await A.getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';
    if (!settings.provider) return A.showError('Open extension settings and configure a provider first.');
    if (settings.provider !== 'ollama' && !apiKey) return A.showError('API key not set. Open extension popup to configure.');

    const fields = A.collectFormFields(A.activeField);
    if (fields.length === 0) return A.showError('No fillable fields found.');

    const descriptors = buildDescriptors(fields);
    const fieldMap = new Map(fields.map((f, i) => ['f' + i, f]));

    const ffBtn = dropdown.querySelector('.aif-fillform');
    ffBtn.disabled = true;
    ffBtn.classList.add('loading');
    ffBtn.textContent = 'Reading form…';

    if (A.ffReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelFillForm', reqId: A.ffReqId });
    }
    const reqId = ++A.genReqCounter;
    A.ffReqId = reqId;

    chrome.runtime.sendMessage({
      action: 'fillForm',
      reqId,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl,
      pageTitle: document.title,
      hostname: location.hostname,
      fields: descriptors,
      userProfile: settings.userProfile || ''
    }, (response) => {
      if (reqId !== A.ffReqId) return;
      A.ffReqId = null;
      ffBtn.disabled = false;
      ffBtn.classList.remove('loading');
      ffBtn.textContent = 'Fill entire form';

      if (chrome.runtime.lastError || !response?.success) {
        return A.showError(response?.error || 'Fill form failed.');
      }
      let parsed;
      try { parsed = JSON.parse(response.text); } catch (e) {
        console.warn('[Aide] fillForm raw response:', response.text);
        return A.showError('Bad response from model. Try a more capable model or Anthropic.');
      }
      // Some local models nest the array under a different key, or return the
      // array directly. Accept any of the three shapes before giving up.
      const fills = Array.isArray(parsed?.fills) ? parsed.fills
                  : Array.isArray(parsed)        ? parsed
                  : Array.isArray(parsed?.values)? parsed.values
                  : [];
      if (!fills.length) {
        console.warn('[Aide] fillForm parsed but no fills:', parsed);
        return A.showError('No values returned.');
      }

      A.ffState = { descriptors, fieldMap, fills };
      renderFFList();
      setPreviewMode();
      // Reposition for the (now taller) preview panel.
      A.positionDropdown(A.activeField);
    });
  });

  dropdown.querySelector('.aif-ff-cancel').addEventListener('click', () => {
    A.ffState = null;
    setComposeMode();
    dropdown.querySelector('.aif-ff-list').innerHTML = '';
    if (A.activeField) A.positionDropdown(A.activeField);
  });

  dropdown.querySelector('.aif-ff-apply').addEventListener('click', () => {
    if (!A.ffState) return;
    // Read user-edited values from inputs.
    const rows = dropdown.querySelectorAll('.aif-ff-row');
    const items = [];
    rows.forEach(row => {
      const key = row.getAttribute('data-key');
      const field = A.ffState.fieldMap.get(key);
      if (!field) return;
      const value = row.querySelector('.aif-ff-input').value;
      if (!value) return; // empty = skip
      // Snapshot the prior value so undo can restore it.
      const prior = A.isContentEditable(field)
        ? (field.innerHTML || '')
        : (field.value || '');
      items.push({ field, value, prior, isCE: A.isContentEditable(field) });
    });

    A.hideDropdown();
    A.hideBtn();

    if (!items.length) return;

    // Stagger inserts ~50ms apart so dependent forms (validators, MobX
    // re-renders, country->state cascades) settle between writes instead of
    // racing.
    items.forEach((it, i) => {
      setTimeout(() => A.insertIntoField(it.field, it.value), i * 50);
    });

    showUndoToast(items);
  });

  // ---- Undo toast ----

  let undoToast = null;
  let undoTimer = null;

  function showUndoToast(items) {
    if (undoToast) undoToast.remove();
    clearTimeout(undoTimer);

    undoToast = document.createElement('div');
    undoToast.className = 'aif-ff-undo-toast';
    undoToast.innerHTML = `
      <span>Filled ${items.length} field${items.length === 1 ? '' : 's'}.</span>
      <button class="aif-ff-undo" type="button">Undo</button>
      <button class="aif-ff-toast-close" type="button" aria-label="Dismiss">✕</button>
    `;
    document.body.appendChild(undoToast);

    const dismiss = () => {
      if (!undoToast) return;
      undoToast.remove();
      undoToast = null;
      clearTimeout(undoTimer);
    };

    undoToast.querySelector('.aif-ff-undo').addEventListener('click', () => {
      // Restore in reverse order; for contenteditable use innerHTML to keep
      // any rich formatting that was there before our paste.
      items.slice().reverse().forEach((it, i) => {
        setTimeout(() => {
          if (it.isCE) {
            it.field.focus();
            it.field.innerHTML = it.prior;
            it.field.dispatchEvent(new InputEvent('input', { bubbles: true }));
          } else {
            const proto = it.field instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(it.field, it.prior);
            else it.field.value = it.prior;
            it.field.dispatchEvent(new Event('input', { bubbles: true }));
            it.field.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, i * 30);
      });
      dismiss();
    });

    undoToast.querySelector('.aif-ff-toast-close').addEventListener('click', dismiss);
    undoTimer = setTimeout(dismiss, 8000);
  }
})();
