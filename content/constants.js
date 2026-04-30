(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  A.FIELD_SELECTOR = [
    'input[type="text"]', 'input[type="email"]', 'input[type="search"]',
    'input[type="url"]', 'input[type="tel"]', 'input[type="number"]',
    'textarea', 'input:not([type])',
    'select',
    '[contenteditable="true"]', '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]'
  ].join(', ');

  // autocomplete tokens that signal payment / credentials / one-time codes.
  // We never want to AI-generate into these (Stripe Checkout, bank login pages,
  // 2FA inputs). https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
  A.SENSITIVE_AUTOCOMPLETE = /\b(cc-|credit-card|card-|current-password|new-password|one-time-code|otp|pin|cvc|cvv)\b/i;

  A.SETTINGS_KEYS = ['provider', 'model', 'ollamaBaseUrl', 'claudeApiKey', 'openaiApiKey', 'geminiApiKey', 'fillFormEnabled', 'enabled', 'snipAskFirst'];
})();
