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
  A.uiRoot.appendChild(btn);
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
  A.uiRoot.appendChild(dropdown);
  A.dropdown = dropdown;

  // The .aif-* descendants are static — innerHTML above defines them once and
  // we never replace them (only their text/attrs). Re-querying on every mode
  // switch, openDropdown, showError, focus dispatch, and streaming-paint tick
  // was a measurable hot path; caching the references makes those constant.
  // The fill-form preview rows (.aif-ff-row inside ffList) ARE rebuilt by
  // renderFFList, so we still query those live.
  const els = {
    header:    dropdown.querySelector('.aif-header'),
    labelText: dropdown.querySelector('.aif-label-text'),
    badge:     dropdown.querySelector('.aif-badge'),
    close:     dropdown.querySelector('.aif-close'),
    prompt:    dropdown.querySelector('.aif-prompt'),
    generate:  dropdown.querySelector('.aif-generate'),
    fillform:  dropdown.querySelector('.aif-fillform'),
    result:    dropdown.querySelector('.aif-result'),
    ffPanel:   dropdown.querySelector('.aif-ff-panel'),
    ffList:    dropdown.querySelector('.aif-ff-list'),
    ffCancel:  dropdown.querySelector('.aif-ff-cancel'),
    ffApply:   dropdown.querySelector('.aif-ff-apply')
  };

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
    els.header.style.display   = '';
    els.prompt.style.display   = '';
    els.generate.style.display = '';
    // ffBtn visibility tracks the popup toggle; settings are cached after
    // the first openDropdown so this read is synchronous in steady state.
    const ffEnabled = !!(A.cachedSettings?.fillFormEnabled);
    els.fillform.style.display = ffEnabled ? '' : 'none';
    els.ffPanel.style.display  = 'none';
  }

  function setPreviewMode() {
    // Header describes the anchor field — irrelevant when previewing values
    // for the entire form. Hide compose UI + header, show only the preview.
    els.header.style.display   = 'none';
    els.prompt.style.display   = 'none';
    els.generate.style.display = 'none';
    els.fillform.style.display = 'none';
    els.result.style.display   = 'none';
    els.ffPanel.style.display  = '';
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
    els.labelText.textContent = labelText;
    els.result.textContent    = '';
    els.result.className      = 'aif-result';
    els.result.style.display  = 'none';
    els.generate.disabled     = false;
    els.generate.textContent  = 'Generate';
    els.generate.classList.remove('loading');
    // restore last prompt with text selected so user can overwrite easily
    els.prompt.value = A.lastPrompt;
    requestAnimationFrame(() => {
      els.prompt.focus();
      if (A.lastPrompt) els.prompt.select();
    });

    A.getSettings().then(d => {
      const labels = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama' };
      els.badge.textContent = labels[d.provider] || '⚙ Not configured';
      // Fill-form is gated by an explicit user toggle in the popup. Hide the
      // button entirely when off so it doesn't take visual space; show it
      // when enabled.
      els.fillform.style.display = d.fillFormEnabled ? '' : 'none';
      els.fillform.disabled      = false;
      els.fillform.title         = '';
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
    els.generate.disabled    = false;
    els.generate.textContent = 'Generate';
    els.generate.classList.remove('loading');
    els.result.className     = 'aif-result aif-error';
    els.result.textContent   = msg;
    els.result.style.display = 'block';
  };

  // ---- Wiring ----

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // prevents field losing focus/selection
    if (A.activeField) A.openDropdown(A.activeField);
  });

  els.close.addEventListener('click', () => {
    A.hideDropdown();
    A.hideBtn();
  });

  // Drag from the header strip to reposition the dropdown. The buttons
  // inside the header (close, etc.) keep working — makeDraggable bails on
  // interactive descendants.
  A.makeDraggable?.(dropdown, els.header);

  els.generate.addEventListener('click', async () => {
    if (!A.activeField) return;

    const settings = await A.getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    if (!settings.provider) {
      return A.showError('Open extension settings and configure a provider first.');
    }
    if (settings.provider !== 'ollama' && !apiKey) {
      return A.showError('API key not set. Open extension popup to configure.');
    }

    A.lastPrompt = els.prompt.value.trim();

    els.generate.disabled    = true;
    els.generate.textContent = '· · ·';
    els.generate.classList.add('loading');

    els.result.className     = 'aif-result';
    els.result.style.display = 'none';

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
      hostname: location.hostname,
      userProfile: settings.userProfile || ''
    };

    const resetBtn = () => {
      els.generate.disabled    = false;
      els.generate.textContent = 'Generate';
      els.generate.classList.remove('loading');
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

  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      els.generate.click();
    }
  });

  // ---- Fill entire form ----

  function buildDescriptors(fields) {
    // Form-scope context (form aria/labelledby/heading) is identical for
    // every field under the same form. Compute it once on the anchor and
    // hand it to extractFieldContext so the per-field loop skips N-1
    // closest('form') walks plus the querySelector('h1...legend') sweep on
    // dense SPA forms. Fieldset legend is still resolved per-field.
    const formScopeContext = fields.length ? A.computeFormScopeContext(fields[0]) : '';
    return fields.map((f, i) => {
      const ctx = A.extractFieldContext(f, { formScopeContext });
      // hostname is per-page, not per-field — drop from the descriptor and
      // pass once at the request level.
      delete ctx.hostname;
      return { key: 'f' + i, ...ctx };
    });
  }

  function renderFFList() {
    if (!A.ffState) return;
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
    els.ffList.innerHTML = rows || '<div class="aif-ff-empty">No fields returned.</div>';
  }

  els.fillform.addEventListener('click', async () => {
    if (!A.activeField) return;

    const settings = await A.getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';
    if (!settings.provider) return A.showError('Open extension settings and configure a provider first.');
    if (settings.provider !== 'ollama' && !apiKey) return A.showError('API key not set. Open extension popup to configure.');

    const fields = A.collectFormFields(A.activeField);
    if (fields.length === 0) return A.showError('No fillable fields found.');

    const descriptors = buildDescriptors(fields);
    const fieldMap = new Map(fields.map((f, i) => ['f' + i, f]));

    els.fillform.disabled = true;
    els.fillform.classList.add('loading');
    els.fillform.textContent = 'Reading form…';

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
      els.fillform.disabled = false;
      els.fillform.classList.remove('loading');
      els.fillform.textContent = 'Fill entire form';

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

  els.ffCancel.addEventListener('click', () => {
    A.ffState = null;
    setComposeMode();
    els.ffList.innerHTML = '';
    if (A.activeField) A.positionDropdown(A.activeField);
  });

  els.ffApply.addEventListener('click', () => {
    if (!A.ffState) return;
    // Read user-edited values from inputs. Rows are dynamic — rebuilt by
    // renderFFList — so they're queried live rather than from the els cache.
    const rows = els.ffList.querySelectorAll('.aif-ff-row');
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
    A.uiRoot.appendChild(undoToast);

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
