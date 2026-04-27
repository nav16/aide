// Persistent log of completed AI interactions (explain / define / followup /
// generate / fillForm). Storage.local only — entries can include selection
// text and form values derived from the user's profile, both of which are PII
// we don't want to sync across devices.
//
// Capped FIFO so storage stays well under the ~5MB local quota even for
// chatty users; oldest entries roll off first.

const HISTORY_KEY = 'aideHistory';
const HISTORY_MAX = 200;

export async function appendHistory(entry) {
  const stored = await chrome.storage.local.get([HISTORY_KEY]);
  const list = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  list.push({ id: crypto.randomUUID(), ts: Date.now(), ...entry });
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
}

export async function getHistory() {
  const stored = await chrome.storage.local.get([HISTORY_KEY]);
  return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
}

export async function clearHistory() {
  await chrome.storage.local.remove([HISTORY_KEY]);
}
