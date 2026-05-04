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

  // Earlier impl used { childList: true, subtree: true } on documentElement.
  // O(1) callback or not, that's a wakeup on EVERY DOM mutation across the
  // page — millions over a long Gmail/Notion session. Two narrower observers
  // give the same coverage at a fraction of the wakeup count:
  //   1. Outer (documentElement, childList only): catches body replacement.
  //      Remix's hydrateRoot(document) on job-boards.eu.greenhouse.io and a
  //      few Next.js setups swap the entire <body>; outer fires once for it.
  //   2. Inner (host's parent, childList only): catches host removal when
  //      its siblings are mutated without replacing the parent. Re-armed
  //      onto the new parent whenever the outer observer detects a swap.
  let innerTarget = null;
  let innerObserver = null;

  function watchHostParent() {
    const parent = host.parentNode || document.body || document.documentElement;
    if (parent === innerTarget) return;
    if (innerObserver) innerObserver.disconnect();
    innerTarget = parent;
    if (!parent) return;
    innerObserver = new MutationObserver(() => {
      if (!host.isConnected) mount();
    });
    innerObserver.observe(parent, { childList: true });
  }

  if (document.documentElement) {
    new MutationObserver(() => {
      if (!host.isConnected) mount();
      // After re-mount on a body swap, host.parentNode is the new body —
      // re-arm the inner observer so it watches the right element.
      watchHostParent();
    }).observe(document.documentElement, { childList: true });
  }
  watchHostParent();

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

  // SW pre-warms content.css into chrome.storage.session. On iframe-heavy
  // pages (ad-laden articles, embedded job boards) every frame's bootstrap
  // would otherwise race to fetch the same packaged file. Hitting session
  // storage first lets all frames share one fetch per browser session.
  // Falls back to fetch when the cache is cold (extension reload mid-page,
  // SW didn't get to warm before content scripts ran) or session storage
  // isn't accessible from this frame.
  (async () => {
    let css = '';
    try {
      const cached = await chrome.storage.session.get('aideContentCss');
      css = cached?.aideContentCss || '';
    } catch {}
    if (!css) {
      try { css = await fetch(chrome.runtime.getURL('content/content.css')).then(r => r.text()); }
      catch { return; }
      // Best-effort populate so the next frame on this page hits the cache.
      try { chrome.storage.session.set({ aideContentCss: css }); } catch {}
    }
    styleEl.textContent = css;
  })();

  A.shadowHost = host;
  A.shadowRoot = root;
  // Append to this when adding new injected UI. Falls back to body for the
  // unlikely case the shadow root failed to attach (older Edge/Safari).
  A.uiRoot = root;

  // Keyboard events are composed: true, so a keystroke in our shadow-root
  // <input> bubbles into the document. At the document, e.target has been
  // retargeted to the shadow host (a <div>), so site hotkey libraries
  // (GitHub, Gmail, Reddit, YouTube, Notion) that skip-when-focused-in-input
  // don't recognize our input and fire shortcuts on every letter the user
  // types. Stop printable-character events at the shadow boundary when the
  // origin is editable. Keep Escape/Tab/Enter/Arrows and modifier combos
  // flowing so the document-level Escape dismiss in main.js still works.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    root.addEventListener(type, (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!e.key || e.key.length !== 1) return;
      const t = e.composedPath()[0];
      if (!t || t.nodeType !== 1) return;
      if (t.isContentEditable ||
          t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT') {
        e.stopPropagation();
      }
    });
  }
})();
