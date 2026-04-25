(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // Pierce shadow DOM: visit node + every shadow root reachable through
  // descendants. Native querySelectorAll stops at shadow boundaries; many apps
  // (Salesforce, YouTube chrome, design-system widgets) render form fields
  // inside shadow trees.
  //
  // TreeWalker is significantly cheaper than `querySelectorAll('*')` on chatty
  // SPAs: no NodeList allocation, no live/static array materialization, and
  // GC pressure stays low as MutationObserver fires hundreds of times per
  // second on pages like Gmail or Notion.
  A.walkRoots = function walkRoots(node, visit) {
    visit(node);
    if (node.shadowRoot) walkRoots(node.shadowRoot, visit);
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (!node.firstChild) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) walkRoots(el.shadowRoot, visit);
    }
  };

  A.observedShadowRoots = new WeakSet();
})();
