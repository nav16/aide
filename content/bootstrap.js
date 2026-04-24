(function () {
  'use strict';

  if (window.__aiFiller) {
    window.__aide = { skip: true };
    return;
  }
  window.__aiFiller = true;

  // Bail early in tiny sub-frames (payment widgets, tracking pixels, ad slots)
  // so we never inject UI into Stripe Elements, reCAPTCHA, etc.
  if (window !== window.top) {
    const w = window.innerWidth  || document.documentElement.clientWidth  || 0;
    const h = window.innerHeight || document.documentElement.clientHeight || 0;
    if (w < 250 || h < 80) {
      window.__aide = { skip: true };
      return;
    }
  }

  window.__aide = {};
})();
