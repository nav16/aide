(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // ---- DOM setup ----

  const selPopup = document.createElement('div');
  selPopup.className = 'aif-sel-popup';
  selPopup.innerHTML = `
    <div class="aif-sel-header">
      <span class="aif-sel-type"></span>
      <div class="aif-sel-actions">
        <button class="aif-sel-prev hidden" aria-label="Previous turn" type="button">◂</button>
        <button class="aif-sel-next hidden" aria-label="Next turn" type="button">▸</button>
        <button class="aif-sel-copy hidden" aria-label="Copy" type="button">⧉</button>
        <button class="aif-sel-close" aria-label="Close" type="button">✕</button>
      </div>
    </div>
    <div class="aif-sel-body"></div>
    <form class="aif-sel-followup hidden">
      <input class="aif-sel-ask" type="text" placeholder="Ask a follow-up…" autocomplete="off">
      <button class="aif-sel-ask-btn" type="submit" aria-label="Ask">↵</button>
    </form>
  `;
  selPopup.style.display = 'none';
  A.uiRoot.appendChild(selPopup);
  A.selPopup = selPopup;

  const copyBtn       = selPopup.querySelector('.aif-sel-copy');
  const followupForm  = selPopup.querySelector('.aif-sel-followup');
  const followupInput = selPopup.querySelector('.aif-sel-ask');
  const prevBtn       = selPopup.querySelector('.aif-sel-prev');
  const nextBtn       = selPopup.querySelector('.aif-sel-next');

  A.hideSelPopup = function () {
    selPopup.style.display = 'none';
    // Abort any explain/followup still in flight. Without this, dismissing
    // (Esc, click-outside, selection collapse) keeps the backend call
    // running — the response is dropped on arrival, but the model bill and
    // request slot are already spent. Stream cancel disconnects the port,
    // which triggers the SW-side AbortController.
    if (A.lastStream)     { try { A.lastStream.cancel();     } catch {} A.lastStream = null; }
    if (A.followupStream) { try { A.followupStream.cancel(); } catch {} A.followupStream = null; }
  };

  // ---- Helpers ----

  function isInsideEditableField(node) {
    let el = node.nodeType === 3 ? node.parentElement : node;
    while (el) {
      if (el.matches?.(A.FIELD_SELECTOR)) return true;
      if (el.parentElement) {
        el = el.parentElement;
      } else {
        const root = el.getRootNode();
        el = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return false;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Extract a JSON object from a model response. Tolerates ```json fences,
  // leading "Here is:" preambles, and trailing commentary by scanning for the
  // first balanced {...} block. Returns null if no valid JSON found.
  function extractJson(text) {
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  function renderDefinition(raw, word) {
    const obj = extractJson(raw);
    if (!obj || typeof obj !== 'object') return null;
    const pos = obj.pos || obj.partOfSpeech || '';
    const def = obj.definition || obj.def || '';
    const ex  = obj.example || obj.usage || '';
    if (!def && !pos && !ex) return null;
    const headParts = [];
    if (word) headParts.push(`<span class="aif-def-word">${escapeHtml(word)}</span>`);
    if (pos)  headParts.push(`<span class="aif-def-pos">${escapeHtml(pos)}</span>`);
    const head = headParts.length ? `<div class="aif-def-head">${headParts.join('')}</div>` : '';
    return `
      <div class="aif-def">
        ${head}
        ${def ? `<div class="aif-def-body">${escapeHtml(def)}</div>` : ''}
        ${ex  ? `<div class="aif-def-ex">${escapeHtml(ex)}</div>`    : ''}
      </div>
    `;
  }

  function renderMarkdown(text) {
    // Escape first so all later inserts of <tags> are safe.
    let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Fenced code blocks ```...``` — extract before any inline rules touch them.
    const codeBlocks = [];
    s = s.replace(/```(?:[\w-]+)?\n?([\s\S]*?)```/g, (_, body) => {
      codeBlocks.push(body.replace(/\n+$/, ''));
      return `CODE${codeBlocks.length - 1}`;
    });

    // Inline code `x` — same protect-then-restore trick.
    const inlineCode = [];
    s = s.replace(/`([^`\n]+)`/g, (_, body) => {
      inlineCode.push(body);
      return `ICODE${inlineCode.length - 1}`;
    });

    // Headers (### / ## / #) at line start.
    s = s.replace(/^#{3,6}\s+(.+)$/gm, '<h4>$1</h4>');
    s = s.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^#\s+(.+)$/gm,  '<h2>$1</h2>');

    // Bold / italic. Bold first so ** isn't eaten by *.
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // Group consecutive `- ` / `* ` / `1. ` lines into <ul>/<ol>.
    s = s.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split(/\n/).map(l => l.replace(/^[-*]\s+/, '')).map(l => `<li>${l}</li>`).join('');
      return `\n<ul>${items}</ul>`;
    });
    s = s.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split(/\n/).map(l => l.replace(/^\d+\.\s+/, '')).map(l => `<li>${l}</li>`).join('');
      return `\n<ol>${items}</ol>`;
    });

    // Remaining newlines → <br>, but not inside the block tags we just inserted.
    s = s.replace(/\n(?!<\/?(?:ul|ol|li|h\d)\b)/g, '<br>');

    // Restore code.
    s = s.replace(/ICODE(\d+)/g, (_, i) => `<code>${inlineCode[+i]}</code>`);
    s = s.replace(/CODE(\d+)/g,  (_, i) => `<pre><code>${codeBlocks[+i]}</code></pre>`);
    return s;
  }

  // ---- View model ----
  // A "view" is one bubble of the conversation: either the initial explain /
  // define answer, or a follow-up Q/A pair. Stored as JSON on dataset.views
  // so the popup survives selectionchange churn without losing state.
  // Schema:
  //   { kind: 'explain'|'word'|'followup', a: <plain answer text>,
  //     q?: <followup question>, raw?: <raw word JSON for re-render>,
  //     word?: <selected word for define re-render> }

  function readViews() {
    try { return JSON.parse(selPopup.dataset.views || '[]'); }
    catch { return []; }
  }
  function writeViews(views) {
    selPopup.dataset.views = JSON.stringify(views);
  }
  // Convert views into the {role, content} transcript shape the model expects
  // for follow-up calls. Each followup view contributes two turns; initial
  // answer contributes one assistant turn that anchors the conversation.
  function turnsFromViews(views) {
    const turns = [];
    for (const v of views) {
      if (v.q != null) turns.push({ role: 'user', content: v.q });
      if (v.a != null) turns.push({ role: 'assistant', content: v.a });
    }
    return turns;
  }

  function renderView(idx) {
    const views = readViews();
    if (!views.length) return;
    const clamped = Math.max(0, Math.min(idx, views.length - 1));
    selPopup.dataset.viewIdx = String(clamped);
    const v = views[clamped];

    const typeEl = selPopup.querySelector('.aif-sel-type');
    const bodyEl = selPopup.querySelector('.aif-sel-body');

    const typeMap = { explain: 'EXPLAIN', word: 'DEFINE', followup: 'FOLLOW-UP' };
    typeEl.textContent = typeMap[v.kind] || 'FOLLOW-UP';

    let html = null;
    if (v.kind === 'word' && v.raw) {
      html = renderDefinition(v.raw, v.word);
    }
    if (!html) {
      const qHtml = v.q ? `<div class="aif-sel-q">${escapeHtml(v.q)}</div>` : '';
      html = qHtml + renderMarkdown(v.a || '');
    }
    bodyEl.innerHTML = html;
    bodyEl.className = 'aif-sel-body';

    copyBtn.dataset.copyText = v.a || '';
    copyBtn.classList.toggle('hidden', !v.a);

    const multi = views.length > 1;
    prevBtn.classList.toggle('hidden', !multi);
    nextBtn.classList.toggle('hidden', !multi);
    prevBtn.disabled = !multi || clamped === 0;
    nextBtn.disabled = !multi || clamped === views.length - 1;
  }
  A.renderView = renderView;

  // Pull ~200 chars on each side of the selection so the model can pick the
  // right sense for polysemous words ("bank", "stem", "running"). Walks up
  // from the selection's container until we find a block with enough text
  // to form a useful window, then anchors the slice on the selected term.
  function extractSurrounding(range, selectedText) {
    try {
      const startNode = range.startContainer;
      let el = startNode.nodeType === 3 ? startNode.parentElement : startNode;
      while (el && el !== document.body && (el.textContent || '').length < 80) {
        el = el.parentElement;
      }
      if (!el) return '';
      const full = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!full || full === selectedText) return '';
      const idx = full.indexOf(selectedText);
      if (idx === -1) return full.length > 400 ? full.slice(0, 400) + '…' : full;
      const start = Math.max(0, idx - 200);
      const end   = Math.min(full.length, idx + selectedText.length + 200);
      let snippet = full.slice(start, end);
      if (start > 0)        snippet = '…' + snippet;
      if (end < full.length) snippet = snippet + '…';
      return snippet;
    } catch {
      return '';
    }
  }

  function positionSelPopup(range) {
    const r = range.getBoundingClientRect();
    const popW = 280;
    // Use a fixed estimate of the popup's eventual height (header + body
    // capped at 50vh + followup) instead of selPopup.offsetHeight. Real
    // height grows from ~30px (placeholder "···") to up to ~460px as deltas
    // stream in; measuring after the fact would jump the popup mid-read.
    // Estimating the worst case keeps placement stable for the whole stream.
    const estimatedH = Math.min(window.innerHeight * 0.5 + 80, 460);
    let left = r.left + (r.width / 2) - (popW / 2);
    if (left < 6) left = 6;
    if (left + popW > window.innerWidth - 6) left = window.innerWidth - popW - 6;
    // Default below the selection so content streams away from the user's
    // reading line. Flip above only when there's noticeably more room there.
    const spaceBelow = window.innerHeight - r.bottom - 10;
    const spaceAbove = r.top - 10;
    let top;
    if (spaceBelow >= estimatedH || spaceBelow >= spaceAbove) {
      top = r.bottom + 10;
    } else {
      top = Math.max(6, r.top - estimatedH - 10);
    }
    selPopup.style.left = `${left}px`;
    selPopup.style.top  = `${top}px`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // navigator.clipboard can be blocked on non-secure contexts or by CSP;
      // fall back to the legacy textarea+execCommand path.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  // ---- Explain / Define ----

  async function checkSelection(opts) {
    // forcedKind comes from the right-click context menu — overrides the
    // word/explain auto-pick so "Define" works on multi-word selections and
    // "Explain" works on single words.
    const forcedKind = opts?.forcedKind || null;
    if (!A.enabled) { A.hideSelPopup(); return; }
    // User clicking into the follow-up input collapses the page selection and
    // refires selectionchange; don't dismiss the popup while they're
    // interacting with our own UI. activeElement at document scope retargets
    // to the shadow host — fall back to shadowRoot.activeElement so we see
    // the element actually focused inside the shadow.
    const ae = A.shadowRoot?.activeElement || document.activeElement;
    if (selPopup.contains(ae)) return;
    const sel = window.getSelection();
    // Once the popup is open with an answer, the followup form is visible
    // and the user may be mid-conversation. Clicking the input collapses
    // the page selection (and submit disables/refocuses it), which would
    // otherwise auto-dismiss the popup mid-question. While the followup
    // form is up, only Esc / outside-click dismiss it; selection-collapse
    // alone is no longer enough.
    const inConvo = selPopup.style.display === 'block' &&
                    !followupForm.classList.contains('hidden');
    if (!sel || sel.isCollapsed) {
      if (inConvo) return;
      A.hideSelPopup();
      return;
    }
    const text = sel.toString().trim();
    if (!text || text.length < 2) {
      if (inConvo) return;
      A.hideSelPopup();
      return;
    }

    const range = sel.getRangeAt(0);
    if (isInsideEditableField(range.commonAncestorContainer)) { A.hideSelPopup(); return; }

    const isWord = /^\S+$/.test(text) && text.length < 40;
    const kind   = forcedKind || (isWord ? 'word' : 'explain');

    const bodyEl = selPopup.querySelector('.aif-sel-body');
    const typeEl = selPopup.querySelector('.aif-sel-type');

    // same text already showing — no need to re-fetch. Skip the short-circuit
    // when the menu forces a different kind so a "Define" click after a
    // running "Explain" actually swaps the answer.
    if (selPopup.style.display === 'block' && selPopup.dataset.selText === text && !forcedKind) {
      positionSelPopup(range);
      return;
    }

    A.selReqId++;
    const myReqId = A.selReqId;

    if (A.lastStream) { try { A.lastStream.cancel(); } catch {} A.lastStream = null; }

    typeEl.textContent = isWord ? 'DEFINE' : 'EXPLAIN';
    bodyEl.textContent = '···';
    bodyEl.className = 'aif-sel-body loading';
    selPopup.dataset.selText = text;
    selPopup.dataset.originalText = text; // anchor for any follow-up turns
    selPopup.dataset.views = '[]';        // accumulated turns, navigable via prev/next
    selPopup.dataset.viewIdx = '0';
    copyBtn.classList.add('hidden');
    followupForm.classList.add('hidden');
    prevBtn.classList.add('hidden');
    nextBtn.classList.add('hidden');
    followupInput.value = '';

    positionSelPopup(range);
    selPopup.style.display = 'block';

    const settings = await A.getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    // For define, lift surrounding text so the model can disambiguate senses.
    // Skip for explain — the selection itself already supplies its context.
    const surrounding = kind === 'word' ? extractSurrounding(range, text) : '';
    const explainPayload = {
      kind,
      text,
      context: surrounding ? { surrounding } : undefined,
      pageTitle: document.title,
      hostname: location.hostname,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl
    };

    // word kind returns JSON via the structured-output path — partial JSON
    // is useless to paint, so we suppress live deltas and render once at done.
    //
    // For prose kinds: deltas arrive ~80x for a 500-token answer, and each
    // call here re-runs the full markdown parse + replaces all of bodyEl —
    // O(N²) work over the stream. rAF-coalesce so we do at most one parse
    // per frame; the user can't read faster than that anyway. We track only
    // the latest cumulative text since each delta supersedes the previous.
    let paintPending = false;
    let paintLatest  = '';
    const livePaint = kind !== 'word'
      ? (full) => {
          paintLatest = full;
          if (paintPending) return;
          paintPending = true;
          requestAnimationFrame(() => {
            paintPending = false;
            if (myReqId !== A.selReqId) return;
            if (selPopup.style.display === 'none') return;
            bodyEl.className = 'aif-sel-body';
            bodyEl.innerHTML = renderMarkdown(paintLatest);
          });
        }
      : null;

    const stream = A.streamExplain(explainPayload, livePaint);
    A.lastStream = stream;
    const response = await stream;
    if (A.lastStream === stream) A.lastStream = null;
    if (myReqId !== A.selReqId) return; // superseded by newer selection
    if (response.cancelled) return;
    if (selPopup.style.display === 'none') return;

    bodyEl.className = 'aif-sel-body';
    if (!response.success) {
      bodyEl.textContent = response.error || 'Failed to fetch.';
      bodyEl.className = 'aif-sel-body aif-sel-error';
    } else {
      let displayText = response.text;
      let raw = null;
      if (kind === 'word') {
        const obj = extractJson(response.text);
        if (obj) {
          raw = response.text;
          // Plain-text version for clipboard / followup transcript: humans
          // and the LLM both prefer prose over JSON when chaining.
          displayText = [
            obj.pos        ? `(${obj.pos})` : '',
            obj.definition || obj.def || '',
            (obj.example || obj.usage) ? `Ex: ${obj.example || obj.usage}` : ''
          ].filter(Boolean).join(' ');
        }
      }
      // Seed views with the initial answer. renderView paints body + nav.
      const view = { kind, a: displayText };
      if (kind === 'word' && raw) { view.raw = raw; view.word = text; }
      writeViews([view]);
      renderView(0);
      followupForm.classList.remove('hidden');
    }
    // No re-position here: placement was decided once at start using a
    // worst-case height estimate, and body now scrolls internally instead
    // of growing the popup. Repositioning would jump the popup just as the
    // user finished reading.
  }
  A.checkSelection = checkSelection;

  // ---- Follow-up ----

  function submitFollowup() {
    const question = followupInput.value.trim();
    if (!question) return;
    sendFollowup(question);
  }

  followupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitFollowup();
  });

  // Explicit Enter handler — some pages wrap our UI inside their own form or
  // stop submit events from bubbling, so rely on keydown rather than the
  // implicit form submit to stay robust. Shift+Enter reserved for future
  // multi-line input.
  followupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      submitFollowup();
    }
  });

  async function sendFollowup(question) {
    const originalText = selPopup.dataset.originalText || '';
    const views = readViews();
    // Cap transcript at last 12 turns (~6 exchanges) so prompt size stays
    // bounded on long sessions; older context falls off but the originalText
    // stays anchored via the explainPrompts followup branch.
    let turns = turnsFromViews(views);
    if (turns.length > 12) turns = turns.slice(-12);
    const lastAssistant = [...views].reverse().find(v => v.a)?.a || '';
    if (!originalText) return;

    const settings = await A.getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    const bodyEl = selPopup.querySelector('.aif-sel-body');
    const typeEl = selPopup.querySelector('.aif-sel-type');

    typeEl.textContent = 'FOLLOW-UP';
    bodyEl.textContent = '···';
    bodyEl.className = 'aif-sel-body loading';
    copyBtn.classList.add('hidden');
    followupInput.disabled = true;

    // Cancel any prior follow-up still in flight.
    if (A.followupStream) { try { A.followupStream.cancel(); } catch {} A.followupStream = null; }

    // Same rAF coalesce as the explain path: deltas arrive faster than the
    // user can read, and re-parsing the full markdown string per chunk is
    // O(N²) over the stream. One parse per frame, paint the latest text.
    let paintPending = false;
    let paintLatest  = '';
    const stream = A.streamExplain({
      kind: 'followup',
      text: question,
      context: { originalText, prior: lastAssistant, turns },
      pageTitle: document.title,
      hostname: location.hostname,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl
    }, (full) => {
      paintLatest = full;
      if (paintPending) return;
      paintPending = true;
      requestAnimationFrame(() => {
        paintPending = false;
        if (A.followupStream !== stream) return; // superseded
        if (selPopup.style.display === 'none') return;
        bodyEl.className = 'aif-sel-body';
        bodyEl.innerHTML = renderMarkdown(paintLatest);
      });
    });
    A.followupStream = stream;
    const response = await stream;
    if (A.followupStream === stream) A.followupStream = null;
    followupInput.disabled = false;
    if (response.cancelled) return;
    if (selPopup.style.display === 'none') return;
    bodyEl.className = 'aif-sel-body';
    if (!response.success) {
      bodyEl.textContent = response.error || 'Failed to fetch.';
      bodyEl.className = 'aif-sel-body aif-sel-error';
    } else {
      // Append the new Q/A as another view; jump to it. Past views stay
      // navigable via prev/next.
      const updated = readViews();
      updated.push({ kind: 'followup', q: question, a: response.text });
      writeViews(updated);
      renderView(updated.length - 1);
      followupInput.value = '';
      followupInput.focus();
    }
  }

  // ---- Wiring ----

  selPopup.querySelector('.aif-sel-close').addEventListener('click', A.hideSelPopup);

  prevBtn.addEventListener('click', () => {
    const idx = parseInt(selPopup.dataset.viewIdx || '0', 10);
    renderView(idx - 1);
  });
  nextBtn.addEventListener('click', () => {
    const idx = parseInt(selPopup.dataset.viewIdx || '0', 10);
    renderView(idx + 1);
  });
  // Arrow-key navigation when focus is anywhere inside the popup but not
  // inside the followup input (left/right are caret nav there).
  selPopup.addEventListener('keydown', (e) => {
    if (e.target === followupInput) return;
    if (e.key === 'ArrowLeft')  { prevBtn.click(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { nextBtn.click(); e.preventDefault(); }
  });

  copyBtn.addEventListener('click', async () => {
    const text = copyBtn.dataset.copyText || selPopup.querySelector('.aif-sel-body').textContent;
    if (!text) return;
    const ok = await copyText(text);
    const prev = copyBtn.textContent;
    copyBtn.textContent = ok ? '✓' : '✕';
    setTimeout(() => { copyBtn.textContent = prev; }, 900);
  });

  let selDebounce = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selDebounce);
    selDebounce = setTimeout(checkSelection, 300);
  });

  // Right-click → context menu pick. SW routes the click to the frame the
  // user clicked in (via info.frameId), so only this frame's listener fires.
  // The page selection is still live at this point — checkSelection reads
  // window.getSelection() directly; we just hand it the forced kind.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'contextMenu') {
      checkSelection({ forcedKind: msg.kind });
    }
  });
})();
