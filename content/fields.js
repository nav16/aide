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

  // Cheap visibility check: zero-size or display:none/visibility:hidden/opacity:0.
  // getClientRects() is empty for `display:none`. Multi-step forms hide
  // inactive steps via display:none, so this filters them out for free.
  A.isFieldVisible = function (field) {
    if (!field.getClientRects().length) return false;
    const r = field.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = window.getComputedStyle(field);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  };

  // Find the form-shaped scope around an anchor field. Tries the closest
  // <form>, then walks up looking for any container with 2+ matching fields
  // (modern SPAs frequently skip the <form> element). Falls back to <body>
  // so single-field "forms" still work, just at page scope.
  A.collectFormFields = function (anchor) {
    let scope = anchor.closest('form');
    if (!scope) {
      let el = anchor.parentElement;
      while (el && el !== document.body) {
        if (el.querySelectorAll(A.FIELD_SELECTOR).length >= 2) { scope = el; break; }
        el = el.parentElement;
      }
    }
    if (!scope) scope = document.body;
    const all = Array.from(scope.querySelectorAll(A.FIELD_SELECTOR));
    if (!all.includes(anchor)) all.unshift(anchor);
    return all.filter(f => {
      if ((f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') && (f.readOnly || f.disabled)) return false;
      if (A.isSensitiveField(f)) return false;
      // Inner-editable check matches attach() — outer wrappers delegate to a
      // child editable, instrumenting them corrupts the editor's DOM model.
      if (A.isContentEditable(f) && f.querySelector('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]')) return false;
      if (!A.isFieldVisible(f)) return false;
      return true;
    });
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
      // Defer to next frame so the dropdown's hide() and our previous focus
      // changes settle before we re-focus and operate on the selection range.
      // 50ms setTimeout was visibly laggy on fast machines; rAF is one frame
      // (~16ms) and runs after layout, which is what we actually need.
      requestAnimationFrame(() => {
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
        // preventDefault() to signal they handled it.
        //
        // Multi-line text needs per-line dispatch: a single 'insertText'
        // event with '\n' in `data` is treated by editors (Gmail compose,
        // Lexical) as one chunk of typed characters, and `\n` isn't a valid
        // typed char — so they collapse it. Splitting into insertText +
        // insertParagraph chunks matches how a real keyboard would deliver
        // the same input.
        const hasNewlines = text.includes('\n');
        if (!hasNewlines) {
          if (dispatchBeforeInput(field, text, 'insertText')) return;
          if (dispatchBeforeInput(field, text, 'insertReplacementText')) return;
        } else {
          const lines = text.split('\n');
          // Probe with the first non-empty line to detect whether the editor
          // consumes insertText. If the probe is canceled, editor is handling
          // these events — continue the chain. Otherwise abort and let the
          // execCommand fallback take over (don't pollute the editor with a
          // partial chain of unhandled events).
          let firstIdx = lines.findIndex(l => l.length > 0);
          if (firstIdx === -1) firstIdx = 0;
          // Need to dispatch insertParagraph for any leading empty lines too
          // so block structure matches the source.
          if (dispatchBeforeInput(field, lines[firstIdx] || '\n', firstIdx === 0 ? 'insertText' : 'insertParagraph')) {
            // Editor took the probe. Some editors (Gmail compose) consume
            // insertText but ignore synthetic insertParagraph — the result
            // would be plain text with no breaks. Detect that on the first
            // break event: try insertParagraph, then insertLineBreak, then
            // synthesize an Enter keydown (Gmail honors this even when not
            // trusted). If all three are ignored, abort so the execCommand
            // fallback can run.
            const dispatchBreak = () => {
              if (dispatchBeforeInput(field, '\n', 'insertParagraph')) return true;
              if (dispatchBeforeInput(field, '\n', 'insertLineBreak'))  return true;
              const ev = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true, composed: true
              });
              return !field.dispatchEvent(ev);
            };
            let breaksHonored = true;
            for (let i = firstIdx + 1; i < lines.length; i++) {
              if (!dispatchBreak()) { breaksHonored = false; break; }
              if (lines[i]) dispatchBeforeInput(field, lines[i], 'insertText');
            }
            if (breaksHonored) return;
            // Breaks ignored mid-chain. Editor now holds partial text without
            // structure — wipe it before falling through to execCommand so we
            // don't compound the damage.
            try {
              const r = document.createRange();
              r.selectNodeContents(field);
              sel.removeAllRanges();
              sel.addRange(r);
              document.execCommand('delete', false, null);
            } catch {}
          }
          // Probe failed — try insertReplacementText with the full text as a
          // last beforeinput option (some spellcheck-style editors only catch
          // this inputType and may handle embedded newlines themselves).
          if (dispatchBeforeInput(field, text, 'insertReplacementText')) return;
        }

        // 2. execCommand — Draft.js, Quill, older TinyMCE, Gmail compose.
        let ok = false;
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
              if (i > 0) {
                // Some editors return false for execCommand('insertParagraph')
                // but accept insertHTML with a <br>. Try paragraph first; fall
                // back to a literal <br> if the editor refused it.
                const para = document.execCommand('insertParagraph', false, null);
                if (!para) document.execCommand('insertHTML', false, '<br>');
              }
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
            // Build a fragment of textNode/<br>/textNode... so newlines survive.
            // A single createTextNode(text) collapses '\n' to whitespace under
            // standard CSS white-space rules — flattens multi-paragraph output.
            const frag = document.createDocumentFragment();
            const lines = text.split('\n');
            let lastNode = null;
            lines.forEach((line, i) => {
              if (i > 0) frag.appendChild(document.createElement('br'));
              if (line) {
                lastNode = document.createTextNode(line);
                frag.appendChild(lastNode);
              }
            });
            range.insertNode(frag);
            const endRange = document.createRange();
            if (lastNode) endRange.setStartAfter(lastNode);
            else endRange.selectNodeContents(field), endRange.collapse(false);
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
      // Code editors (Monaco on LeetCode/VSCode-web, CodeMirror, Ace) mount a
      // hidden textarea for IME/keyboard input but keep their real document in
      // a separate model — setting `value` on the textarea never reaches the
      // editor. Detect those by ancestor and dispatch a synthetic paste event
      // with the text in DataTransfer; the editors all read clipboardData and
      // apply the insert through their own command pipeline.
      const codeHost = field.closest?.('.monaco-editor, .cm-editor, .CodeMirror, .ace_editor');
      if (codeHost) {
        field.focus();
        let dt = null;
        try {
          dt = new DataTransfer();
          dt.setData('text/plain', text);
        } catch {}
        if (dt) {
          const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          });
          field.dispatchEvent(pasteEvent);
          // beforeinput insertFromPaste covers editors that ignore synthetic
          // ClipboardEvents but still honor InputEvents (some CM6 builds).
          const ie = new InputEvent('beforeinput', {
            inputType: 'insertFromPaste',
            data: text,
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            composed: true
          });
          field.dispatchEvent(ie);
        }
        return;
      }
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
    // No per-field focus/blur listeners — main.js installs a single
    // document-capture pair that dispatches via attachedFields membership.
  };
})();
