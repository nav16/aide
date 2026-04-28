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

  // Subtree:true so we catch host removal regardless of whether body is
  // replaced wholesale (Remix's hydrateRoot(document) on job-boards.eu.greenhouse.io,
  // certain Next.js apps) or just has children swapped. The callback is
  // O(1) — host.isConnected is a fast bit check — so the firehose of
  // mutations on a busy SPA is fine.
  const reattachObserver = new MutationObserver(() => {
    if (!host.isConnected) mount();
  });
  if (document.documentElement) {
    reattachObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Belt-and-braces: a MutationObserver fires *after* the mutation, and on
  // some sites the hydration sweep that strips our host happens in a tight
  // loop where a single re-attach gets stripped again before the user sees
  // anything. Re-mount at the standard ready milestones too. mount() is a
  // no-op when already attached, so the cost is negligible.
  document.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('load', mount);
  [50, 200, 600, 1500, 3000].forEach(t => setTimeout(mount, t));

  const root = host.attachShadow({ mode: 'open' });

  // Inline <style> instead of <link href="chrome-extension://...">: strict
  // page CSPs (Greenhouse, GitHub, banks) often set style-src without a
  // chrome-extension: source and refuse the link. fetch() runs in the content
  // script's isolated world and is not gated by the page CSP, and an inline
  // <style> only needs 'unsafe-inline' which strict policies still grant.
  const styleEl = document.createElement('style');
  root.appendChild(styleEl);
  fetch(chrome.runtime.getURL('content.css'))
    .then(r => r.text())
    .then(css => { styleEl.textContent = css; })
    .catch(() => {});

  A.shadowHost = host;
  A.shadowRoot = root;
  // Append to this when adding new injected UI. Falls back to body for the
  // unlikely case the shadow root failed to attach (older Edge/Safari).
  A.uiRoot = root;
})();
