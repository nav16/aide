(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // captureVisibleTab returns one composited image of the whole tab. Iframe
  // overlays can't align to those pixels, so the overlay only runs in the
  // top frame. SW also targets frameId:0; this guard is defense-in-depth.
  if (window.top !== window) return;

  let overlay   = null;
  let dimEl     = null;
  let rectEl    = null;
  let hintEl    = null;
  let toolbarEl = null;
  let toolbarInput = null;
  let snapshotUrl = null;
  let drag      = null;
  let committedRect = null;

  function teardown() {
    if (overlay) { overlay.remove(); overlay = null; }
    dimEl = rectEl = hintEl = toolbarEl = toolbarInput = null;
    snapshotUrl = null;
    drag = null;
    committedRect = null;
    // Defensive — beginSnip/cancelSnip already restore visibility, but if
    // teardown is reached via some other path (e.g. an exception during
    // buildOverlay) we still want our own UI back.
    if (A.shadowHost) A.shadowHost.style.visibility = '';
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup',   onMouseUp,   true);
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    teardown();
  }

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'aif-snip-overlay';
    overlay.style.backgroundImage = `url("${snapshotUrl}")`;

    dimEl = document.createElement('div');
    dimEl.className = 'aif-snip-dim';
    overlay.appendChild(dimEl);

    rectEl = document.createElement('div');
    rectEl.className = 'aif-snip-rect';
    overlay.appendChild(rectEl);

    hintEl = document.createElement('div');
    hintEl.className = 'aif-snip-hint';
    hintEl.textContent = 'Drag to snip a region · Esc to cancel';
    overlay.appendChild(hintEl);

    overlay.addEventListener('mousedown', onMouseDown);
    A.uiRoot.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    // If the toolbar is up, the user is restarting the selection — drop it
    // and start a fresh drag. Toolbar children stop propagation themselves,
    // so this only runs when the click landed on the dim area or rect.
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
      toolbarInput = null;
      committedRect = null;
    }
    drag = { x: e.clientX, y: e.clientY };
    // Hand the dim duty to the rect's outward box-shadow once the user starts
    // dragging — the area inside the rect stays bright (so they see what they
    // are selecting), everything else darkens via the shadow.
    dimEl.style.display = 'none';
    rectEl.classList.add('aif-snip-rect-active');
    hintEl.style.display = 'none';
    updateRect(e.clientX, e.clientY);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup',   onMouseUp,   true);
  }

  function onMouseMove(e) {
    if (!drag) return;
    updateRect(e.clientX, e.clientY);
  }

  function onMouseUp(e) {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup',   onMouseUp,   true);
    if (!drag) return;
    const r = computeRect(e.clientX, e.clientY);
    drag = null;
    // Tiny rects are almost always accidental clicks — bail without the model
    // call. 8px is below the typical click jitter on trackpads.
    if (r.w < 8 || r.h < 8) { teardown(); return; }
    committedRect = r;
    // snipAskFirst (default on) gates the post-release toolbar. Off = run
    // the default explain immediately on release, no toolbar shown.
    // getSettings is cached after first read; on the rare cold path we
    // fall back to showing the toolbar (safer than firing a request the
    // user didn't expect).
    A.getSettings()
      .then(s => (s?.snipAskFirst !== false ? showToolbar(r) : commit('')))
      .catch(() => showToolbar(r));
  }

  function computeRect(x2, y2) {
    const x1 = drag.x, y1 = drag.y;
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1)
    };
  }

  function updateRect(x2, y2) {
    const r = computeRect(x2, y2);
    rectEl.style.left   = r.x + 'px';
    rectEl.style.top    = r.y + 'px';
    rectEl.style.width  = r.w + 'px';
    rectEl.style.height = r.h + 'px';
  }

  // Floating action bar shown after a successful drag. Lets the user choose
  // between the default explain and a custom question without leaving the
  // overlay. A second mousedown anywhere outside the toolbar drops it and
  // restarts the selection (handled in onMouseDown).
  function showToolbar(rect) {
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'aif-snip-toolbar';

    const explainBtn = document.createElement('button');
    explainBtn.type = 'button';
    explainBtn.className = 'aif-snip-tb-btn aif-snip-tb-explain';
    explainBtn.textContent = 'Explain';

    toolbarInput = document.createElement('input');
    toolbarInput.type = 'text';
    toolbarInput.className = 'aif-snip-tb-input';
    toolbarInput.placeholder = 'Ask about this image…';
    toolbarInput.autocomplete = 'off';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'aif-snip-tb-btn aif-snip-tb-submit';
    submitBtn.setAttribute('aria-label', 'Send question');
    submitBtn.textContent = '↵';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'aif-snip-tb-btn aif-snip-tb-close';
    closeBtn.setAttribute('aria-label', 'Cancel');
    closeBtn.textContent = '✕';

    toolbarEl.appendChild(explainBtn);
    toolbarEl.appendChild(toolbarInput);
    toolbarEl.appendChild(submitBtn);
    toolbarEl.appendChild(closeBtn);

    // Stop mousedowns inside the toolbar from bubbling into the overlay's
    // drag-restart handler. Without this, focusing the input or clicking
    // a button would tear the toolbar down and start a fresh selection.
    toolbarEl.addEventListener('mousedown', (e) => e.stopPropagation());

    explainBtn.addEventListener('click', () => commit(''));
    submitBtn.addEventListener('click', () => commit(toolbarInput.value.trim()));
    closeBtn.addEventListener('click', teardown);
    toolbarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        commit(toolbarInput.value.trim());
      }
    });

    overlay.appendChild(toolbarEl);
    positionToolbar(rect);
    // Auto-focus the input so users can start typing immediately or just
    // press Enter for the default explain — no extra click needed.
    toolbarInput.focus();
  }

  function positionToolbar(rect) {
    // Anchor below the rect when there's room; flip above otherwise. Width
    // is left to CSS (auto + max-width); we measure after mount to clamp
    // horizontally to the viewport.
    const margin = 8;
    const tbW = toolbarEl.offsetWidth  || 360;
    const tbH = toolbarEl.offsetHeight || 40;

    let left = rect.x + (rect.w / 2) - (tbW / 2);
    if (left < 6) left = 6;
    if (left + tbW > window.innerWidth - 6) left = window.innerWidth - tbW - 6;

    const spaceBelow = window.innerHeight - (rect.y + rect.h) - margin;
    const spaceAbove = rect.y - margin;
    const top = (spaceBelow >= tbH || spaceBelow >= spaceAbove)
      ? rect.y + rect.h + margin
      : rect.y - tbH - margin;

    toolbarEl.style.left = left + 'px';
    toolbarEl.style.top  = top + 'px';
  }

  function commit(userQuestion) {
    if (!committedRect) { teardown(); return; }
    cropAndExplain(committedRect, userQuestion).catch(err => {
      console.error('[aide] snip crop failed:', err);
      teardown();
    });
  }

  async function cropAndExplain(r, userQuestion) {
    // captureVisibleTab returns physical pixels; mouse coords are CSS pixels.
    // Scale by devicePixelRatio so a retina/4K screen does not produce a
    // half-zoomed crop.
    const dpr = window.devicePixelRatio || 1;
    const sx = Math.round(r.x * dpr);
    const sy = Math.round(r.y * dpr);
    const sw = Math.round(r.w * dpr);
    const sh = Math.round(r.h * dpr);

    const blob   = await fetch(snapshotUrl).then(res => res.blob());
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const cropBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const cropUrl  = await blobToDataUrl(cropBlob);

    // Anchor the answer popup to the cropped rectangle: pass a DOMRect-like
    // so positionSelPopup can place above/below the snip area, same logic
    // as text-selection.
    const popupRect = {
      left:   r.x,
      top:    r.y,
      right:  r.x + r.w,
      bottom: r.y + r.h,
      width:  r.w,
      height: r.h
    };
    teardown();
    if (typeof A.openImageExplain === 'function') {
      A.openImageExplain(popupRect, cropUrl, userQuestion || '');
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload  = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Hide the entire shadow host — every Aide UI element (focus button,
    // generate dropdown, explain popup, fill-form preview) lives inside
    // it, so one toggle covers all of them. Two rAFs guarantee the style
    // change has actually painted before we ack: rAF #1 flushes the style
    // write, rAF #2 fires after the next paint. Only then is it safe for
    // the SW to call captureVisibleTab.
    if (msg?.action === 'prepSnip') {
      if (A.shadowHost) A.shadowHost.style.visibility = 'hidden';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try { sendResponse({ ok: true }); } catch {}
      }));
      return true; // keep the response channel open for async sendResponse
    }
    // SW capture failed (restricted page, etc.) — restore visibility so
    // the user's Aide UI is not stuck hidden until next page load.
    if (msg?.action === 'cancelSnip') {
      if (A.shadowHost) A.shadowHost.style.visibility = '';
      return;
    }
    if (msg?.action === 'beginSnip') {
      if (overlay) return;
      snapshotUrl = msg.dataUrl;
      if (!snapshotUrl) return;
      // Restore *before* building the overlay — it is a child of the same
      // shadow host we hid for capture.
      if (A.shadowHost) A.shadowHost.style.visibility = '';
      buildOverlay();
    }
  });
})();
