(function () {
  'use strict';

  if (window.__aiFiller) {
    window.__aide = { skip: true };
    return;
  }
  window.__aiFiller = true;

  // Previously bailed on tiny sub-frames at document_idle to avoid injecting
  // UI into Stripe Elements / reCAPTCHA. Removed: iframes that load below
  // the threshold and resize later (e.g. Greenhouse application boards
  // embedded by Thoughtworks careers) were skipped permanently. Payment/auth
  // iframes are already filtered at attach time by isSensitiveField
  // (cc-/card/cvv/otp/password autocomplete and name patterns).
  const A = window.__aide = {};

  // All injected UI lives inside this shadow root so host-page CSS can't
  // bleed into our popup/dropdown/toast (line-height resets, button border
  // overrides, font-size globals, etc.). The host element uses display:contents
  // so it doesn't affect document flow — children with position:fixed lay out
  // against the viewport regardless.
  const host = document.createElement('div');
  host.id = 'aide-root';
  host.style.cssText = 'all: initial; display: contents;';
  // React 18 hydration on some sites (job-boards.greenhouse.io, certain
  // Next.js apps) strips children added under <html> before hydration runs,
  // because the SSR HTML doesn't contain them. Mark the node so React's own
  // "ignore extension-injected nodes" path leaves it alone, and watch for
  // removal as a backstop.
  host.setAttribute('data-extension', 'aide');

  function mount() {
    const parent = document.body || document.documentElement;
    if (!parent || host.parentNode === parent) return;
    parent.appendChild(host);
  }
  mount();

  // If a re-render or hydration sweep removes our host, put it back. The
  // shadow root and its contents are preserved across detach/re-attach since
  // they live on the host element, not its parent. Observe both <html> (in
  // case body is rebuilt) and <body> directly.
  const reattachObserver = new MutationObserver(() => {
    if (!host.isConnected) mount();
  });
  if (document.documentElement) {
    reattachObserver.observe(document.documentElement, { childList: true });
  }
  // body may not exist yet at document_idle in odd setups; observe once it's
  // there too. This is cheap — childList only, no subtree.
  const bodyObserver = new MutationObserver(() => {
    if (document.body) {
      reattachObserver.observe(document.body, { childList: true });
      mount();
      bodyObserver.disconnect();
    }
  });
  if (!document.body && document.documentElement) {
    bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
  } else if (document.body) {
    reattachObserver.observe(document.body, { childList: true });
  }

  const root = host.attachShadow({ mode: 'open' });

  // Pull our packaged CSS into the shadow root via <link>. content.css is
  // listed in manifest's web_accessible_resources so the URL is fetchable.
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content.css');
  root.appendChild(link);

  A.shadowHost = host;
  A.shadowRoot = root;
  // Append to this when adding new injected UI. Falls back to body for the
  // unlikely case the shadow root failed to attach (older Edge/Safari).
  A.uiRoot = root;
})();
