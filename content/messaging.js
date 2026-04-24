(function () {
  'use strict';
  if (window.__aide?.skip) return;
  const A = (window.__aide ||= {});

  // Settings cache — background.js reads these per request, and storage round
  // trips add up across every keystroke in the follow-up input. Invalidate on
  // any storage change so popup edits take effect without a page reload.
  A.cachedSettings = null;

  A.getSettings = function () {
    if (A.cachedSettings) return Promise.resolve(A.cachedSettings);
    return new Promise(r => chrome.storage.sync.get(A.SETTINGS_KEYS, data => {
      A.cachedSettings = data;
      r(data);
    }));
  };

  chrome.storage.onChanged.addListener(() => { A.cachedSettings = null; });

  // Request-id counters shared across files. `selReqId` is reused for explain
  // *and* follow-up so later turns supersede earlier ones with a single check.
  A.genReqCounter   = 0;
  A.currentGenReqId = null;
  A.selReqId        = 0;
  A.lastSentReqId   = null;
  A.followupReqId   = null;
})();
