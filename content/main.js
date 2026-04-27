(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // ---- Lazy attach via focus dispatch ----
  // Earlier versions walked the entire DOM at startup and again on every
  // MutationObserver flush, just to populate attachedFields. On dense SPAs
  // (Notion, Salesforce, Gmail) most fields are never touched, so the scan
  // was pure cost. We now attach lazily: when a focus event arrives for a
  // matching field, gate it through attach() then run onFocus.
  //
  // focusin/focusout are composed events, so capture-phase listeners on
  // document catch focus from inside open shadow roots too. composedPath()[0]
  // gives the real target after retargeting at the shadow boundary. Closed
  // shadow roots don't expose inner targets — those fields are skipped, which
  // matches our prior behavior (closed roots blocked Range ops anyway).
  function realTarget(e) {
    return (e.composedPath && e.composedPath()[0]) || e.target;
  }

  // Events from inside our injected shadow root retarget to the shadow host.
  // Detect via path — if our host is in the propagation chain, the event came
  // from our own UI and we ignore it (otherwise focusing our preview <input>
  // would be treated as the user focusing a new page field).
  function fromOurUI(e) {
    return A.shadowHost && e.composedPath().includes(A.shadowHost);
  }

  document.addEventListener('focusin', (e) => {
    if (fromOurUI(e)) return;
    const target = realTarget(e);
    if (!target || target.nodeType !== 1) return;
    if (!A.attachedFields.has(target)) {
      // Match the same selector the old scan used; attach() does the rest of
      // the gating (sensitive fields, readonly, inner-editable).
      if (!target.matches?.(A.FIELD_SELECTOR)) return;
      A.attach(target);
      if (!A.attachedFields.has(target)) return; // attach rejected it
    }
    A.onFocus({ target });
  }, true);

  document.addEventListener('focusout', (e) => {
    if (fromOurUI(e)) return;
    const target = realTarget(e);
    if (!target || !A.attachedFields.has(target)) return;
    A.onBlur({ target });
  }, true);

  // ---- Global UI dismissals ----

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (A.dropdown.style.display !== 'none') A.hideDropdown();
      if (A.selPopup.style.display !== 'none') A.hideSelPopup();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (A.dropdown.style.display === 'none') return;
    // composedPath crosses the shadow boundary — without it, e.target is the
    // retargeted shadow host and `dropdown.contains(target)` is always false,
    // so a click *inside* the dropdown would dismiss it.
    const path = e.composedPath();
    if (!path.includes(A.dropdown) && !path.includes(A.btn)) A.hideDropdown();
  });

  document.addEventListener('mousedown', (e) => {
    if (A.selPopup.style.display === 'none') return;
    if (!e.composedPath().includes(A.selPopup)) {
      // only dismiss immediately if not starting a new selection (single click, not drag)
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) A.hideSelPopup();
      }, 10);
    }
  });

  // ---- Startup ----
  // Page may have already auto-focused a field before our content script ran
  // (document_idle fires after autofocus). Surface the button for it.
  const active = document.activeElement;
  if (active && active !== document.body && active.matches?.(A.FIELD_SELECTOR)) {
    A.attach(active);
    if (A.attachedFields.has(active)) A.onFocus({ target: active });
  }
})();
