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
  window.__aide = {};
})();
