(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // ---- Field scan + shadow-root observation ----

  function scanAndObserve(node) {
    if (node.nodeType === 1 && node.matches?.(A.FIELD_SELECTOR)) A.attach(node);
    A.walkRoots(node, r => {
      r.querySelectorAll?.(A.FIELD_SELECTOR).forEach(A.attach);
      if (r instanceof ShadowRoot && !A.observedShadowRoots.has(r)) {
        A.observedShadowRoots.add(r);
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

  // ---- Global UI dismissals ----

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (A.dropdown.style.display !== 'none') A.hideDropdown();
      if (A.selPopup.style.display !== 'none') A.hideSelPopup();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (A.dropdown.style.display === 'none') return;
    if (!A.dropdown.contains(e.target) && e.target !== A.btn) A.hideDropdown();
  });

  document.addEventListener('mousedown', (e) => {
    if (A.selPopup.style.display === 'none') return;
    if (!A.selPopup.contains(e.target)) {
      // only dismiss immediately if not starting a new selection (single click, not drag)
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) A.hideSelPopup();
      }, 10);
    }
  });

  // ---- Kick off ----

  scanAndObserve(document.body);
  new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
})();
