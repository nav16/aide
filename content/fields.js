(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // WeakSet instead of a DOM dataset flag: React/Vue/etc. can re-render from
  // state and strip custom dataset attrs, which would make us re-attach
  // listeners on every re-render. A WeakSet keyed by the element survives
  // re-renders without mutating the DOM, and the entry GCs when the node
  // itself is collected.
  A.attachedFields = new WeakSet();

  A.isContentEditable = function (el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return false;
    const ce = el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '' || ce === 'plaintext-only') return true;
    // role="textbox" on a non-input element — ARIA widget, treat like
    // contenteditable for insertion (editor handles beforeinput/paste itself).
    return el.getAttribute('role') === 'textbox';
  };

  A.isSensitiveField = function (field) {
    const ac = field.getAttribute('autocomplete');
    if (ac && A.SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
    const name = field.getAttribute('name') || '';
    const id   = field.id || '';
    // Common naming patterns for card/OTP/password inputs across checkout
    // frameworks and form libraries that don't set autocomplete properly.
    if (/\b(card|cvc|cvv|cardnumber|card_number|securitycode|otp|pin|passcode|password)\b/i.test(name + ' ' + id)) return true;
    return false;
  };

  A.humanizeName = function (name) {
    return name
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_\-.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\w/, c => c.toUpperCase());
  };

  A.extractLabel = function (field) {
    if (field.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const ariaLabel = field.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = field.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.trim().split(/\s+/);
      const text = ids.map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
      if (text) return text;
    }

    const parentLabel = field.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach(e => e.remove());
      const t = clone.textContent.trim();
      if (t) return t;
    }

    if (field.name) return A.humanizeName(field.name);

    // Nearby heading / label text above the field
    const prev = field.previousElementSibling;
    if (prev && /^(label|span|p|div|h\d)$/i.test(prev.tagName)) {
      const t = prev.textContent.trim();
      if (t && t.length < 80) return t;
    }

    return 'this field';
  };

  function extractPlaceholder(field) {
    // data-placeholder used by rich-text editors (Notion, Slack)
    const p = field.getAttribute('placeholder') || field.getAttribute('data-placeholder');
    return p ? p.trim() : '';
  }

  function extractFieldType(field) {
    if (field.tagName === 'TEXTAREA') return 'textarea';
    if (A.isContentEditable(field)) return 'contenteditable';
    return (field.getAttribute('type') || 'text').toLowerCase();
  }

  function extractDescribedBy(field) {
    const ids = field.getAttribute('aria-describedby');
    if (!ids) return '';
    const text = ids.trim().split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean).join(' ');
    return text.length > 240 ? text.slice(0, 240) + '…' : text;
  }

  function extractFormContext(field) {
    const fieldset = field.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector(':scope > legend');
      if (legend?.textContent.trim()) return legend.textContent.trim();
      const al = fieldset.getAttribute('aria-label');
      if (al) return al.trim();
    }
    const form = field.closest('form');
    if (form) {
      const ariaLabel = form.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      const labelledBy = form.getAttribute('aria-labelledby');
      if (labelledBy) {
        // aria-labelledby is a space-separated ID list; resolve each and join.
        const t = labelledBy.trim().split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean).join(' ');
        if (t) return t;
      }
      // Heading inside form
      const h = form.querySelector('h1, h2, h3, h4, legend');
      if (h?.textContent.trim()) return h.textContent.trim().slice(0, 120);
    }
    return '';
  }

  A.extractFieldContext = function (field) {
    const ctx = { label: A.extractLabel(field) };
    const placeholder = extractPlaceholder(field);
    if (placeholder && placeholder !== ctx.label) ctx.placeholder = placeholder;

    ctx.inputType = extractFieldType(field);

    // Current draft, if any. Lets the model continue/refine instead of
    // discarding what the user already typed. Cap at 2k chars so we don't
    // dump entire essays into the prompt.
    const currentValue = ctx.inputType === 'contenteditable'
      ? (field.innerText || field.textContent || '').trim()
      : (field.value || '').trim();
    if (currentValue) {
      ctx.currentValue = currentValue.length > 2000 ? currentValue.slice(0, 2000) + '…' : currentValue;
    }

    const ac = field.getAttribute('autocomplete');
    if (ac && ac !== 'off' && ac !== 'on') ctx.autocomplete = ac.trim();

    const pattern = field.getAttribute('pattern');
    if (pattern) ctx.pattern = pattern;

    if (field.required || field.getAttribute('aria-required') === 'true') ctx.required = true;

    if (field.maxLength > 0) ctx.maxChars = field.maxLength;
    else {
      const max = parseInt(field.getAttribute('maxlength') || field.getAttribute('data-maxlength'), 10);
      if (max > 0) ctx.maxChars = max;
    }
    if (field.minLength > 0) ctx.minChars = field.minLength;

    if (ctx.inputType === 'number') {
      const mn = field.getAttribute('min');
      const mx = field.getAttribute('max');
      const st = field.getAttribute('step');
      if (mn != null) ctx.min = mn;
      if (mx != null) ctx.max = mx;
      if (st != null) ctx.step = st;
    }

    const help = extractDescribedBy(field);
    if (help) ctx.describedBy = help;

    const form = extractFormContext(field);
    if (form && form !== ctx.label) ctx.formContext = form;

    ctx.hostname = location.hostname;
    return ctx;
  };

  // Dispatch a cancelable beforeinput event. Modern editors (Lexical,
  // ProseMirror v2, Slate) subscribe to this and apply edits via their own
  // models, calling preventDefault() to signal they took ownership. The browser
  // itself never treats synthetic InputEvents as trusted, so if nothing cancels
  // it, the caller must fall back to another insertion path.
  // Returns true if the editor consumed it.
  function dispatchBeforeInput(field, text, inputType) {
    let dt = null;
    try {
      dt = new DataTransfer();
      dt.setData('text/plain', text);
    } catch { /* DataTransfer constructor unavailable in some sandboxes */ }
    const ev = new InputEvent('beforeinput', {
      inputType,
      data: text,
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      composed: true
    });
    return !field.dispatchEvent(ev);
  }

  A.insertIntoField = function (field, text) {
    if (A.isContentEditable(field)) {
      setTimeout(() => {
        field.focus();
        // Select existing contents so the insert replaces them across every path.
        const sel = window.getSelection();
        const preRange = document.createRange();
        preRange.selectNodeContents(field);
        sel.removeAllRanges();
        sel.addRange(preRange);

        // 1. beforeinput — future-proof replacement for execCommand. Lexical,
        // modern ProseMirror, Slate, and other editors listen for InputEvents
        // and apply the change through their own reducers, calling
        // preventDefault() to signal they handled it. Try 'insertText' first
        // (canonical typing path, what ChatGPT/Claude.ai/Gemini reduce) and
        // fall back to 'insertReplacementText' for editors that only catch
        // the spellcheck-style inputType.
        if (dispatchBeforeInput(field, text, 'insertText')) return;
        if (dispatchBeforeInput(field, text, 'insertReplacementText')) return;

        // 2. execCommand — Draft.js, Quill, older TinyMCE, Gmail compose.
        let ok = false;
        const hasNewlines = text.includes('\n');
        if (!hasNewlines) {
          // Single-line: selectAll + insertText replaces selection in one shot.
          // Skipping the intermediate delete keeps the editor's internal model in sync
          // (React/custom editors like Twitter update state via beforeinput on insertText,
          // but may ignore the delete step and retain the original text when serializing).
          document.execCommand('selectAll', false, null);
          ok = document.execCommand('insertText', false, text);
        } else {
          // Multi-line: delete first then insert line-by-line — inserting full text with \n
          // in one execCommand loses newlines in rich-text editors like Gmail.
          const cleared = document.execCommand('selectAll', false, null) &&
                          document.execCommand('delete', false, null);
          ok = cleared;
          if (cleared) {
            const lines = text.split('\n');
            lines.forEach((line, i) => {
              if (i > 0) document.execCommand('insertParagraph', false, null);
              if (line) ok = document.execCommand('insertText', false, line) && ok;
            });
          }
        }
        if (!ok) {
          // 3. Bare contenteditable with no framework.
          try {
            const range = document.createRange();
            range.selectNodeContents(field);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            const endRange = document.createRange();
            endRange.setStartAfter(node);
            endRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(endRange);
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          } catch (e) {
            field.textContent = text;
            field.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
        }
      }, 50);
    } else {
      const proto = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(field, text);
      else field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
  };

  A.hideBtnTimer = null;

  A.onFocus = function (e) {
    if (A.dropdown.contains(e.target) || e.target === A.btn) return; // ignore our own UI
    clearTimeout(A.hideBtnTimer); // cancel any pending hide from a prior blur
    A.activeField = e.target;
    A.positionBtn(A.activeField);
  };

  A.onBlur = function () {
    A.hideBtnTimer = setTimeout(() => {
      if (document.activeElement !== A.btn && !A.dropdown.contains(document.activeElement)) {
        A.hideBtn();
      }
    }, 200);
  };

  A.attach = function (field) {
    if (A.attachedFields.has(field)) return;
    if (A.dropdown.contains(field) || field === A.btn) return; // never instrument our own UI
    if ((field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') &&
        (field.readOnly || field.disabled)) return;
    if (A.isSensitiveField(field)) return;
    // For contenteditable: attach only to the innermost editable node —
    // the one with no contenteditable children. Outer wrappers (Draft.js root,
    // Quill container, etc.) delegate editing to an inner node; targeting them
    // causes Range ops to corrupt the editor's internal DOM structure.
    // Plain querySelector is sufficient here — editors essentially never put
    // their inner editable inside a shadow root, so the cost of walkRoots
    // (full subtree walk per attach) isn't justified.
    if (A.isContentEditable(field)) {
      if (field.querySelector('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]')) return;
    }

    A.attachedFields.add(field);
    field.addEventListener('focus', A.onFocus);
    field.addEventListener('blur', A.onBlur);
  };
})();
