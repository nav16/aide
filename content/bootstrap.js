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
  // documentElement so the host survives some SPAs that re-render <body>.
  (document.documentElement || document.body).appendChild(host);

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
