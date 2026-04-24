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
  document.body.appendChild(selPopup);
  A.selPopup = selPopup;

  const copyBtn       = selPopup.querySelector('.aif-sel-copy');
  const followupForm  = selPopup.querySelector('.aif-sel-followup');
  const followupInput = selPopup.querySelector('.aif-sel-ask');

  A.hideSelPopup = function () { selPopup.style.display = 'none'; };

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

  function renderMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function positionSelPopup(range) {
    const r = range.getBoundingClientRect();
    const popW = 280;
    const popH = selPopup.offsetHeight || 120;
    let left = r.left + (r.width / 2) - (popW / 2);
    if (left < 6) left = 6;
    if (left + popW > window.innerWidth - 6) left = window.innerWidth - popW - 6;
    let top = r.top - popH - 10;
    if (top < 6) top = r.bottom + 10;
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

  async function checkSelection() {
    // User clicking into the follow-up input collapses the page selection and
    // refires selectionchange; don't dismiss the popup while they're
    // interacting with our own UI.
    if (selPopup.contains(document.activeElement)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { A.hideSelPopup(); return; }
    const text = sel.toString().trim();
    if (!text || text.length < 2) { A.hideSelPopup(); return; }

    const range = sel.getRangeAt(0);
    if (isInsideEditableField(range.commonAncestorContainer)) { A.hideSelPopup(); return; }

    const isWord = /^\S+$/.test(text) && text.length < 40;
    const kind   = isWord ? 'word' : 'explain';

    const bodyEl = selPopup.querySelector('.aif-sel-body');
    const typeEl = selPopup.querySelector('.aif-sel-type');

    // same text already showing — no need to re-fetch
    if (selPopup.style.display === 'block' && selPopup.dataset.selText === text) {
      positionSelPopup(range);
      return;
    }

    A.selReqId++;
    const myReqId = A.selReqId;

    if (A.lastSentReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelExplain', reqId: A.lastSentReqId });
    }

    typeEl.textContent = isWord ? 'DEFINE' : 'EXPLAIN';
    bodyEl.textContent = '···';
    bodyEl.className = 'aif-sel-body loading';
    selPopup.dataset.selText = text;
    selPopup.dataset.originalText = text; // anchor for any follow-up turns
    selPopup.dataset.priorAnswer = '';
    copyBtn.classList.add('hidden');
    followupForm.classList.add('hidden');
    followupInput.value = '';

    positionSelPopup(range);
    selPopup.style.display = 'block';

    const settings = await A.getSettings();
    const apiKey = settings[`${settings.provider}ApiKey`] || '';

    const explainPayload = {
      action: 'explain',
      kind,
      text,
      pageTitle: document.title,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl
    };

    A.lastSentReqId = myReqId;
    chrome.runtime.sendMessage({ ...explainPayload, reqId: myReqId }, (response) => {
      if (myReqId === A.lastSentReqId) A.lastSentReqId = null;
      if (myReqId !== A.selReqId) return; // superseded by newer selection
      if (selPopup.style.display === 'none') return;
      bodyEl.className = 'aif-sel-body';
      if (chrome.runtime.lastError || !response?.success) {
        bodyEl.textContent = response?.error || 'Failed to fetch.';
        bodyEl.className = 'aif-sel-body aif-sel-error';
      } else {
        bodyEl.innerHTML = renderMarkdown(response.text);
        copyBtn.dataset.copyText = response.text;
        copyBtn.classList.remove('hidden');
        selPopup.dataset.priorAnswer = response.text;
        followupForm.classList.remove('hidden');
      }
      positionSelPopup(range);
    });
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
    const prior        = selPopup.dataset.priorAnswer  || '';
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
    if (A.followupReqId !== null) {
      chrome.runtime.sendMessage({ action: 'cancelExplain', reqId: A.followupReqId });
    }
    const myReqId = ++A.selReqId;
    A.followupReqId = myReqId;

    chrome.runtime.sendMessage({
      action: 'explain',
      reqId: myReqId,
      kind: 'followup',
      text: question,
      context: { originalText, prior },
      pageTitle: document.title,
      provider: settings.provider,
      apiKey,
      model: settings.model,
      ollamaBaseUrl: settings.ollamaBaseUrl
    }, (response) => {
      if (myReqId !== A.followupReqId) return; // superseded
      A.followupReqId = null;
      followupInput.disabled = false;
      if (selPopup.style.display === 'none') return;
      bodyEl.className = 'aif-sel-body';
      if (chrome.runtime.lastError || !response?.success) {
        bodyEl.textContent = response?.error || 'Failed to fetch.';
        bodyEl.className = 'aif-sel-body aif-sel-error';
      } else {
        bodyEl.innerHTML = renderMarkdown(response.text);
        copyBtn.dataset.copyText = response.text;
        copyBtn.classList.remove('hidden');
        // Chain into prior answer so the next follow-up sees this turn too.
        selPopup.dataset.priorAnswer = response.text;
        followupInput.value = '';
        followupInput.focus();
      }
    });
  }

  // ---- Wiring ----

  selPopup.querySelector('.aif-sel-close').addEventListener('click', A.hideSelPopup);

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
})();
