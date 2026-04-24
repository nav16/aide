(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // Pierce shadow DOM: visit node + every shadow root reachable through
  // descendants. Native querySelectorAll stops at shadow boundaries; many apps
  // (Salesforce, YouTube chrome, design-system widgets) render form fields
  // inside shadow trees.
  A.walkRoots = function walkRoots(node, visit) {
    visit(node);
    if (node.shadowRoot) walkRoots(node.shadowRoot, visit);
    const all = node.querySelectorAll ? node.querySelectorAll('*') : null;
    if (!all) return;
    for (const el of all) if (el.shadowRoot) walkRoots(el.shadowRoot, visit);
  };

  A.observedShadowRoots = new WeakSet();
})();
