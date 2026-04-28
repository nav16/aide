(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // Settings cache — background.js reads these per request, and storage round
  // trips add up across every keystroke in the follow-up input. Invalidate on
  // any storage change so popup edits take effect without a page reload.
  A.cachedSettings = null;

  // Synchronous mirror of the global enable toggle. focusin and selectionchange
  // handlers fire too often to await storage on every event, so we keep this
  // boolean fresh and read it inline. Default true so the brief window before
  // the cache warms doesn't black-hole the UI.
  A.enabled = true;

  A.getSettings = function () {
    if (A.cachedSettings) return Promise.resolve(A.cachedSettings);
    // userProfile lives in storage.local (freeform PII, never synced).
    // Merge into the same cached object so callers see one settings shape.
    return Promise.all([
      new Promise(r => chrome.storage.sync.get(A.SETTINGS_KEYS, r)),
      new Promise(r => chrome.storage.local.get(['userProfile'], r))
    ]).then(([sync, local]) => {
      const merged = { ...sync, userProfile: local.userProfile || '' };
      A.cachedSettings = merged;
      A.enabled = merged.enabled !== false;
      return merged;
    });
  };

  // Warm the cache and A.enabled so the first focus event after page load
  // sees the correct toggle state (default-true is fine for the race window,
  // but if the user has Aide globally off we want to honor that immediately).
  A.getSettings();

  chrome.storage.onChanged.addListener((changes) => {
    A.cachedSettings = null;
    if ('enabled' in changes) {
      A.enabled = changes.enabled.newValue !== false;
      // Tear down any visible UI on disable so the user sees the change
      // without needing to refocus / reselect. These helpers are owned by
      // ui.js and selection.js, both of which load before any storage event
      // can realistically arrive (popup write is user-initiated).
      if (!A.enabled) {
        try { A.hideBtn?.(); } catch {}
        try { A.hideDropdown?.(); } catch {}
        try { A.hideSelPopup?.(); } catch {}
      }
    }
  });

  // Request-id counters shared across files. `selReqId` is reused for explain
  // *and* follow-up so later turns supersede earlier ones with a single check.
  A.genReqCounter   = 0;
  A.currentGenReqId = null;
  A.selReqId        = 0;

  // Live-streaming explain transport. Opens a port per call; emits cumulative
  // text via onDelta(full, chunk) as content_block_delta frames arrive, then
  // resolves with { success, text }. The returned promise carries .cancel()
  // which aborts the in-flight provider call by disconnecting the port —
  // server-side onDisconnect aborts the AbortController.
  A.streamExplain = function (payload, onDelta) {
    const port = chrome.runtime.connect({ name: 'aide-stream' });
    let acc = '';
    let resolved = false;
    let resolveFn;
    const promise = new Promise(resolve => {
      resolveFn = resolve;
      port.onMessage.addListener(msg => {
        if (!msg) return;
        if (msg.type === 'delta') {
          acc += msg.text || '';
          try { onDelta?.(acc, msg.text || ''); } catch {}
        } else if (msg.type === 'done') {
          if (resolved) return;
          resolved = true;
          resolve({ success: true, text: msg.text != null ? msg.text : acc });
        } else if (msg.type === 'error') {
          if (resolved) return;
          resolved = true;
          resolve({ success: false, error: msg.error || 'Stream failed.' });
        }
      });
      port.onDisconnect.addListener(() => {
        if (resolved) return;
        resolved = true;
        resolve({ success: false, error: chrome.runtime.lastError?.message || 'Disconnected.' });
      });
    });
    promise.cancel = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      try { port.postMessage({ action: 'cancel' }); } catch {}
      try { port.disconnect(); } catch {}
      resolveFn({ success: false, error: 'Cancelled.', cancelled: true });
    };
    try {
      port.postMessage({ action: 'explain', ...payload });
    } catch (e) {
      // Service worker dead at connect time — surface as an error.
      if (!resolved) {
        resolved = true;
        resolveFn({ success: false, error: e.message || 'Failed to start stream.' });
      }
    }
    return promise;
  };
})();
