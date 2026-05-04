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
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return false;
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

    // Custom-element wrappers (spl-input, mat-form-field, etc.) put the
    // visible label on the host, not the inner native input. When the
    // anchor is inside a shadow root, walk up to the host and inspect its
    // attributes / nearby light-DOM label before any further fallbacks.
    const root = field.getRootNode?.();
    if (root instanceof ShadowRoot && root.host) {
      const host = root.host;
      const hostLabel    = host.getAttribute('label');
      if (hostLabel) return hostLabel.trim();
      const hostAria     = host.getAttribute('aria-label');
      if (hostAria) return hostAria.trim();
      const hostLabelled = host.getAttribute('aria-labelledby');
      if (hostLabelled) {
        const text = hostLabelled.trim().split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean).join(' ');
        if (text) return text;
      }
      if (host.id) {
        const m = document.querySelector(`label[for="${CSS.escape(host.id)}"]`);
        if (m) return m.textContent.trim();
      }
      // Common pattern: <oc-input data-test="personal-info-first-name-input">
      // — the data-test slug is a usable last-resort label source.
      const dataTest = host.getAttribute('data-test') || host.getAttribute('formcontrolname');
      if (dataTest) return A.humanizeName(dataTest.replace(/^.*-/, ''));
    }

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

    // Sibling-label pattern: Ashby, Greenhouse, and similar form frameworks
    // wrap each field in a question container with a <label> sibling that
    // isn't tied via for/id. Often the label text itself is wrapped in a
    // <p>/<span> so `for`-association would be awkward anyway. Walk up a
    // few levels and pick the closest <label> that precedes the field in
    // document order — for ancestors holding multiple field/label pairs
    // (a fieldset, a row), the immediately-preceding label is the right
    // one. Capping at 4 hops avoids drifting up into page chrome.
    let scope = field.parentElement;
    for (let i = 0; scope && i < 4; i++, scope = scope.parentElement) {
      const labels = scope.querySelectorAll('label');
      if (!labels.length) continue;
      // querySelectorAll returns nodes in tree order, so iterating and
      // overwriting on each preceding match leaves us with the latest
      // (closest) one. Stop once we hit a label that comes after the
      // field — every label past it is even further away.
      let lbl = null;
      for (const l of labels) {
        if (l.contains(field)) continue;
        if (l.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING) {
          lbl = l;
        } else {
          break;
        }
      }
      if (lbl) {
        const clone = lbl.cloneNode(true);
        clone.querySelectorAll('input, textarea, select').forEach(e => e.remove());
        const t = clone.textContent.replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    }

    if (field.name) {
      // UUID-style names (Ashby's per-question field IDs, e.g.
      // e5808184-e9e0-402d-a878-8f8dd07c1fd6) humanize to gibberish — fall
      // through to "this field" rather than feed the model a hex blob.
      const isUuidish = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(field.name);
      if (!isUuidish) return A.humanizeName(field.name);
    }

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

  // ARIA combobox pattern (React Select, MUI Autocomplete, Radix, Headless
  // UI, Downshift). The visible "input" is a real <input> with
  // role="combobox" + aria-haspopup; options render in a portal listbox
  // only when open. Different from native <select>: setting `value`
  // doesn't pick an option — we have to type and then click a
  // [role="option"] that the lib renders in response to the typed text.
  function isComboboxInput(field) {
    if (field.tagName !== 'INPUT') return false;
    if (field.getAttribute('role') !== 'combobox') return false;
    const aha = field.getAttribute('aria-haspopup');
    return aha === 'listbox' || aha === 'true';
  }

  function extractFieldType(field) {
    if (field.tagName === 'TEXTAREA') return 'textarea';
    if (field.tagName === 'SELECT')   return 'select';
    if (isComboboxInput(field))       return 'combobox';
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

  // Pull surrounding page text so the model can write contextually — replies
  // that match the thread's tone, comments that reference the post above,
  // forum responses that mirror the topic. Heuristic: walk up from the field
  // and pick the LOWEST ancestor with substantial text content (>= 300 chars).
  // The smallest qualifying container is usually the conversation/thread/card
  // boundary; ancestors above that drift into page chrome (sidebars, navs).
  //
  // The field's own draft is stripped from the result so we don't re-feed
  // the user's in-progress text back to the model as "context."
  //
  // Limitations:
  //   - Sites that mount the compose box as a sibling of the thread (Gmail's
  //     compose dialog floats over the thread, not inside it) won't see the
  //     thread here. A targeted Gmail extractor would be a separate add.
  //   - Capped at 1500 chars so we don't blow up the prompt or send a whole
  //     long article.
  //   - Requires >= 80 chars after stripping the draft, otherwise returns ''
  //     (no signal worth the tokens).
  const NEARBY_MIN_ANCESTOR  = 300;
  const NEARBY_MIN_OUTPUT    = 80;
  const NEARBY_MAX_OUTPUT    = 1500;
  const NEARBY_MAX_HOPS      = 12;

  // Site-specific extractors. Used when ancestor-walking fails because the
  // compose UI is rendered as a sibling of the thread (Gmail's reply
  // dialog) or otherwise can't see the surrounding content from inside.
  // Each function returns the extracted text or '' if nothing usable.

  // Webmail clients put the inline reply box AND the popup composer as
  // siblings of the message list — walking up from the field never
  // reaches the thread, so we scan the document instead.
  //
  // [role="main"] is the ARIA landmark every accessible webmail client
  // uses for the reading pane. Inside a thread view it contains:
  // subject, every visible message (expanded body OR collapsed snippet,
  // both rendered), and the compose box. innerText respects visibility
  // so display:none-hidden bodies of collapsed messages don't pad the
  // result while their snippet previews stay in. The compose draft
  // itself is in there too but the caller strips it via draft-match.
  //
  // Earlier Gmail-specific impl tried per-message containers
  // (`[data-message-id]`, `.a3s.aiL`, `.y2`). Class names shift between
  // A/B experiments — single-message detection broke on multi-reply
  // threads. The landmark approach is variant-proof.
  //
  // Known limitation: ProtonMail and iCloud Mail render each message
  // body inside an isolated <iframe> for security. innerText doesn't
  // cross frame boundaries, so for those clients we'd capture sender +
  // subject metadata but not the actual email body. Not in this map
  // until we add cross-frame extraction.
  function mainPaneContext() {
    const main = document.querySelector('[role="main"]');
    if (!main) return '';
    return (main.innerText || '').replace(/\s+/g, ' ').trim();
  }

  const SITE_EXTRACTORS = {
    'mail.google.com':         mainPaneContext,
    'outlook.live.com':        mainPaneContext,
    'outlook.office.com':      mainPaneContext,
    'outlook.office365.com':   mainPaneContext,
    'mail.yahoo.com':          mainPaneContext,
    'mail.aol.com':            mainPaneContext,
    'app.fastmail.com':        mainPaneContext,
    'mail.zoho.com':           mainPaneContext
  };

  function extractNearbyText(field) {
    const fieldText = (
      field.value != null ? String(field.value)
                          : (field.innerText || field.textContent || '')
    ).trim();
    const flatField = fieldText.replace(/\s+/g, ' ').trim();

    // 1) Try a site-specific extractor first. These exist for hosts where
    //    ancestor-walking can't reach the relevant content (webmail).
    let text = '';
    const siteFn = SITE_EXTRACTORS[location.hostname];
    if (siteFn) {
      try { text = siteFn() || ''; } catch {}
    }

    // 2) Generic ancestor walk fallback. Used when no site extractor
    //    matched, or the site extractor returned nothing usable.
    if (!text) {
      let cur = field;
      let chosen = null;
      for (let i = 0; i < NEARBY_MAX_HOPS; i++) {
        let next = cur.parentElement;
        if (!next) {
          // Cross shadow boundary — fields inside custom-element shadow
          // roots have no parentElement at the root.
          const r = cur.getRootNode?.();
          next = r instanceof ShadowRoot ? r.host : null;
        }
        if (!next || next === document.documentElement) break;
        cur = next;
        if ((cur.textContent || '').length >= NEARBY_MIN_ANCESTOR) {
          chosen = cur;
          break;
        }
      }
      if (!chosen) return '';
      text = (chosen.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // Strip the field's own draft so we don't echo the user's in-progress
    // text back at them. >5 chars threshold avoids over-eager stripping
    // for tiny drafts ("a", "ok") that could match unrelated occurrences.
    if (flatField && flatField.length > 5) {
      const idx = text.indexOf(flatField);
      if (idx !== -1) {
        text = (text.slice(0, idx) + ' ' + text.slice(idx + flatField.length))
          .replace(/\s+/g, ' ').trim();
      }
    }
    if (text.length < NEARBY_MIN_OUTPUT) return '';
    if (text.length > NEARBY_MAX_OUTPUT) text = text.slice(0, NEARBY_MAX_OUTPUT) + '…';
    return text;
  }

  // Per-field: fieldset legend / aria-label. Two fields under different
  // fieldsets get different legends ("Personal info" vs "Address"), so this
  // can't be cached across the field loop.
  function extractFieldsetContext(field) {
    const fieldset = field.closest('fieldset');
    if (!fieldset) return '';
    const legend = fieldset.querySelector(':scope > legend');
    if (legend?.textContent.trim()) return legend.textContent.trim();
    const al = fieldset.getAttribute('aria-label');
    if (al) return al.trim();
    return '';
  }

  // Per-scope: form's aria/labelledby/heading. Identical for every field in
  // the same form, so fillForm computes once and threads the result back via
  // extractFieldContext's `opts.formScopeContext` to skip N-1 redundant
  // closest('form') walks + querySelector('h1...legend') on dense pages.
  A.computeFormScopeContext = function (anchor) {
    const form = anchor.closest?.('form');
    if (!form) return '';
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
    return '';
  };

  function extractFormContext(field, prebuiltScope) {
    // Fieldset (per-field) wins over form scope (shared across fields).
    const fs = extractFieldsetContext(field);
    if (fs) return fs;
    // Hot-path callers (fillForm) pass the precomputed scope; everyone else
    // computes it lazily here.
    if (prebuiltScope !== undefined) return prebuiltScope;
    return A.computeFormScopeContext(field);
  }

  A.extractFieldContext = function (field, opts) {
    const ctx = { label: A.extractLabel(field) };
    const placeholder = extractPlaceholder(field);
    if (placeholder && placeholder !== ctx.label) ctx.placeholder = placeholder;

    ctx.inputType = extractFieldType(field);

    // Native <select>: enumerate options and pass to the model so it can
    // pick one. Cap at 200 entries — the longest realistic select is a
    // ~250-country list, and the marginal value of seeing "Vatican City"
    // and "Wallis and Futuna" past the first 200 is essentially nil.
    // Skip the leading empty/placeholder option some forms use as a "—
    // select —" prompt; the model treats it as a no-op anyway and
    // including it confuses the constrained-choice instruction.
    if (ctx.inputType === 'select') {
      const options = [];
      for (const opt of field.options) {
        const value = opt.value;
        const label = (opt.textContent || '').trim();
        if (!value && !label) continue;
        // Drop the conventional placeholder ("", "Select…") at index 0.
        if (options.length === 0 && !value && /^(select|choose|--)/i.test(label)) continue;
        options.push({ value, label });
        if (options.length >= 200) break;
      }
      if (options.length) ctx.options = options;
    }

    // Current draft / selected value. Lets the model continue/refine
    // instead of discarding what the user already typed (or chose).
    // Cap at 2k chars so we don't dump entire essays into the prompt.
    let currentValue;
    if (ctx.inputType === 'contenteditable') {
      currentValue = (field.innerText || field.textContent || '').trim();
    } else if (ctx.inputType === 'select') {
      // For a select, currentValue should be the LABEL of the selected
      // option, not the raw value — labels carry meaning ("United
      // States" vs "us") that the model can reason about.
      const sel = field.selectedOptions?.[0];
      currentValue = sel && sel.value ? (sel.textContent || sel.value).trim() : '';
    } else {
      currentValue = (field.value || '').trim();
    }
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

    const form = extractFormContext(field, opts?.formScopeContext);
    if (form && form !== ctx.label) ctx.formContext = form;

    // Surrounding text — only for long-form fields where conversational
    // context matters. Email/URL/tel/short-text inputs don't benefit from
    // a thread blob and the extra tokens aren't worth it.
    // opts.skipNearby is set by buildDescriptors (fillForm) where every
    // field would compute the same blob from shared ancestors — wasteful
    // duplicated tokens. fillForm already gets a single formContext.
    const longForm = ctx.inputType === 'textarea' || ctx.inputType === 'contenteditable';
    if (longForm && !opts?.skipNearby) {
      const nearby = extractNearbyText(field);
      if (nearby) ctx.nearbyText = nearby;
    }

    ctx.hostname = location.hostname;
    return ctx;
  };

  // querySelectorAll stops at shadow boundaries. Walk the tree manually so
  // forms built from custom elements (Angular's spl-input, Lit, Stencil, etc.)
  // expose their inner native inputs to us.
  function deepQueryAll(root, selector) {
    const out = [];
    (function walk(n) {
      if (!n) return;
      if (n.nodeType === 1) {
        if (n.matches?.(selector)) out.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
      }
      const kids = n.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(root);
    return out;
  }
  A._deepQueryAll = deepQueryAll;

  // Same idea for going up: parentNode stops at the shadow root, so when we
  // hit one we hop to its host element. Returns the chain from `start` to the
  // top of the document, crossing every shadow boundary on the way.
  function crossShadowAncestors(start) {
    const out = [];
    let cur = start;
    while (cur && cur !== document) {
      out.push(cur);
      if (cur.parentNode && cur.parentNode !== document) {
        cur = cur.parentNode;
      } else {
        const r = cur.getRootNode?.();
        cur = (r instanceof ShadowRoot) ? r.host : null;
      }
    }
    return out;
  }

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
    // Climb crosses shadow boundaries — when the anchor is a native <input>
    // inside an spl-input's shadow root, we can still reach the surrounding
    // <form> in light DOM by hopping shadowRoot → host as needed.
    const ancestors = crossShadowAncestors(anchor);
    let scope = ancestors.find(el => el.tagName === 'FORM');
    let allInScope = null;

    if (!scope) {
      // No <form>: previous impl ran deepQueryAll once per ancestor up to
      // the 8-level cap — worst case 8 full subtree walks crossing every
      // shadow root, on the hot path of every "Fill entire form" click.
      // Now: ONE walk on the topmost candidate, then count per-ancestor
      // memberships in a single pass over the result. Reuses the result
      // verbatim if the chosen scope is the topmost candidate.
      const limit = Math.min(ancestors.length, 8);
      if (limit > 0) {
        const top = ancestors[limit - 1];
        const candidateSet = new Set();
        for (let i = 0; i < limit; i++) candidateSet.add(ancestors[i]);
        const allInTop = deepQueryAll(top, A.FIELD_SELECTOR);
        const counts = new Map();
        // For each found field, walk up its cross-shadow ancestor chain and
        // bump the count on each ancestor that is one of our candidates.
        // Inline (no allocation) version of crossShadowAncestors — this loop
        // runs N×depth times per fillForm click; allocating a per-field
        // ancestor array would add measurable GC pressure on dense forms.
        for (const f of allInTop) {
          let cur = f;
          while (cur && cur !== document) {
            if (candidateSet.has(cur)) counts.set(cur, (counts.get(cur) || 0) + 1);
            if (cur.parentNode && cur.parentNode !== document) {
              cur = cur.parentNode;
            } else {
              const r = cur.getRootNode?.();
              cur = (r instanceof ShadowRoot) ? r.host : null;
            }
          }
        }
        for (let i = 0; i < limit; i++) {
          if ((counts.get(ancestors[i]) || 0) >= 2) {
            scope = ancestors[i];
            // If chosen scope IS the topmost candidate we already walked,
            // skip the redundant deepQueryAll on it below.
            if (scope === top) allInScope = allInTop;
            break;
          }
        }
      }
    }
    if (!scope) scope = document.body;

    const all = allInScope || deepQueryAll(scope, A.FIELD_SELECTOR);
    if (!all.includes(anchor)) all.unshift(anchor);
    return all.filter(f => {
      // Skip our own injected UI — the dropdown's prompt textarea would
      // otherwise be collected as a "form field" with a label scraped from
      // the dropdown header ("Field: First name · Ollama · ✕").
      if (A.dropdown?.contains(f) || f === A.btn) return false;
      if ((f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') && (f.readOnly || f.disabled)) return false;
      if (f.tagName === 'SELECT' && f.disabled) return false;
      if (A.isSensitiveField(f)) return false;
      // Inner-editable check matches attach() — outer wrappers delegate to a
      // child editable, instrumenting them corrupts the editor's DOM model.
      if (A.isContentEditable(f) && deepQueryAll(f, '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]').length) return false;
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
    if (field.tagName === 'SELECT') {
      // Match the model's output against the option list. Try in order:
      //   1. Exact value match (case-insensitive)
      //   2. Exact label match (case-insensitive)
      //   3. Substring match either direction (handles "United States"
      //      vs "United States of America", or model wrapping in quotes)
      // Bail silently if nothing fits — better to leave the select alone
      // than to pick a wrong option and have the user submit it.
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      // Strip wrapping quotes/backticks the model sometimes adds.
      const stripped = String(text || '').trim().replace(/^["'`“‘]+|["'`”’]+$/g, '');
      const target = norm(stripped);
      if (!target) return;

      const opts = Array.from(field.options);
      let chosen = opts.find(o => norm(o.value)       === target)
                || opts.find(o => norm(o.textContent) === target);
      if (!chosen) {
        chosen = opts.find(o => {
          const v = norm(o.value), l = norm(o.textContent);
          return (l && (target.includes(l) || l.includes(target)))
              || (v && (target.includes(v) || v.includes(target)));
        });
      }
      if (!chosen) return;

      // Set via the prototype setter when available — frameworks (React,
      // Vue) intercept the setter on element instances to track state, so
      // a plain assignment can land outside their model. Same pattern we
      // use for input/textarea.
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(field, chosen.value);
      else field.value = chosen.value;
      // Also flip selectedIndex — guards against frameworks that read
      // selectedIndex rather than value (rare but exists).
      field.selectedIndex = chosen.index;
      field.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true, composed: true }));
      field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
      return;
    }

    if (isComboboxInput(field)) {
      // ARIA combobox: setting `value` alone doesn't pick an option —
      // we have to open the listbox, type to filter, and click a
      // [role="option"]. Strategy:
      //   1. Click the input to open the menu (react-select toggles
      //      on click; MUI/Radix/Headless UI also open on click).
      //   2. Type the text via the prototype setter + 'input' event so
      //      the lib filters its options.
      //   3. After ~300ms, scan for [role=option] (scoped to
      //      aria-controls's listbox if set). Pick the best match.
      //   4. Dispatch mousedown+mouseup+click — react-select selects
      //      on mousedown, others on click.
      // Logs prefixed [Aide][combobox] so we can diagnose if the
      // listbox doesn't open or no options match.
      const stripped = String(text || '').trim().replace(/^["'`“‘]+|["'`”’]+$/g, '');
      if (!stripped) return;
      console.log('[Aide][combobox] insert text:', stripped, 'into', field);

      field.focus();
      // Open the menu. react-select-flavored libs respond to click on
      // the input itself; some pure-W3C combobox impls require Alt+Down
      // or Enter, but click covers the common case.
      field.click();

      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      // setTimeout(0) so the click() handler runs before we set value —
      // react-select's onClick opens the menu BEFORE its onChange fires,
      // and changing the value mid-click can race the open path.
      setTimeout(() => {
        if (setter) setter.call(field, stripped);
        else field.value = stripped;
        field.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true, composed: true }));
        field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
        console.log('[Aide][combobox] typed value, aria-expanded=', field.getAttribute('aria-expanded'));
      }, 0);

      setTimeout(() => {
        const listboxId = field.getAttribute('aria-controls');
        const scope = (listboxId && document.getElementById(listboxId)) || document;
        const all = Array.from(scope.querySelectorAll('[role="option"]'));
        const opts = all.filter(o => o.offsetParent !== null);
        console.log('[Aide][combobox] listboxId=', listboxId, 'optsTotal=', all.length, 'optsVisible=', opts.length);
        if (!opts.length) {
          console.log('[Aide][combobox] no visible options, leaving typed text');
          return;
        }

        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const target = norm(stripped);
        let chosen = opts.find(o => norm(o.textContent) === target);
        if (!chosen && target.length > 1) chosen = opts.find(o => norm(o.textContent).includes(target));
        if (!chosen && target.length > 1) chosen = opts.find(o => target.includes(norm(o.textContent)) && norm(o.textContent).length > 1);
        if (!chosen) chosen = opts[0]; // first visible — combobox libs auto-highlight best match

        console.log('[Aide][combobox] chosen option:', chosen.textContent.trim().slice(0, 60));
        chosen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        chosen.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, button: 0 }));
        chosen.click();
      }, 350);
      return;
    }

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

        // Draft.js (Twitter compose, parts of Reddit / Medium) responds to
        // synthetic beforeinput events partially: it picks up `event.data`
        // and visibly inserts text but doesn't preventDefault, so our
        // `!field.dispatchEvent(ev)` probe always reads false and we fall
        // through to execCommand. execCommand then dispatches a TRUSTED
        // beforeinput that Draft.js ALSO handles, producing a second
        // insertion — visible as "text appears in two spans" on Twitter.
        // For these editors we skip the synthetic chain entirely and rely
        // on execCommand's trusted beforeinput, which Draft.js handles
        // correctly in one application.
        const isDraftJs = !!(
          field.querySelector?.('[data-offset-key]') ||
          field.getAttribute?.('data-offset-key')
        );
        if (isDraftJs) {
          if (text.includes('\n')) {
            const cleared = document.execCommand('selectAll', false, null) &&
                            document.execCommand('delete', false, null);
            if (cleared) {
              const lines = text.split('\n');
              lines.forEach((line, i) => {
                if (i > 0) {
                  const para = document.execCommand('insertParagraph', false, null);
                  if (!para) document.execCommand('insertHTML', false, '<br>');
                }
                if (line) document.execCommand('insertText', false, line);
              });
            }
          } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
          }
          return;
        }

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
      // composed:true so events bubble out of any wrapping shadow root —
      // custom elements (spl-input etc.) often attach listeners on the host.
      field.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true, composed: true }));
      field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
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
      // activeElement at document scope retargets to the shadow host when the
      // user is focusing inside our injected UI. shadowRoot.activeElement
      // reveals the actual focused element so we don't hide the button while
      // the user is typing in our dropdown.
      const ae = A.shadowRoot?.activeElement || document.activeElement;
      if (ae !== A.btn && !A.dropdown.contains(ae)) A.hideBtn();
    }, 200);
  };

  A.attach = function (field) {
    if (A.attachedFields.has(field)) return;
    if (A.dropdown.contains(field) || field === A.btn) return; // never instrument our own UI
    if ((field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') &&
        (field.readOnly || field.disabled)) return;
    if (field.tagName === 'SELECT' && field.disabled) return;
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
