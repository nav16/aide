// Persistent log of completed AI interactions (explain / define / followup /
// generate / fillForm). Storage.local only — entries can include selection
// text and form values derived from the user's profile, both of which are PII
// we don't want to sync across devices.
//
// Capped FIFO so storage stays well under the ~5MB local quota even for
// chatty users; oldest entries roll off first.
//
// Writes are coalesced: chrome.storage.local.set rewrites the whole
// HISTORY_KEY blob, which can be 1-4MB on chatty sessions where 200 entries
// each carry long form-fill outputs. Per-call get+set was costing meaningful
// SW time on every successful AI request. Now we hydrate once into memory,
// append in-place, and flush via a 500ms debounce — bursty sessions collapse
// N writes into 1. Trade-off: if the SW is killed inside the debounce window,
// the latest entry can be lost. Acceptable for a history feature; the
// successful AI response itself was already returned to the user.

const HISTORY_KEY     = 'aideHistory';
const HISTORY_MAX     = 200;
const FLUSH_DELAY_MS  = 500;

let cached       = null;   // in-memory mirror; null until first hydrate
let hydrating    = null;   // in-flight hydrate Promise (dedup concurrent loads)
let dirty        = false;  // true when memory has unsaved changes
let flushTimer   = null;
let inFlightWrite = null;  // Promise of the active set() so getHistory can await it

async function hydrate() {
  if (cached) return cached;
  if (hydrating) return hydrating;
  hydrating = chrome.storage.local.get([HISTORY_KEY]).then(stored => {
    cached = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
    hydrating = null;
    return cached;
  });
  return hydrating;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
  flushTimer = null;
  if (!dirty || !cached) return;
  // Snapshot before await so any append() that lands during the write marks
  // dirty=true again and triggers a follow-up flush rather than racing with
  // the in-flight set() (which would otherwise drop the late append).
  dirty = false;
  const snapshot = cached.slice();
  inFlightWrite = chrome.storage.local.set({ [HISTORY_KEY]: snapshot }).catch(() => {});
  try { await inFlightWrite; }
  finally { inFlightWrite = null; }
  if (dirty && !flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

export async function appendHistory(entry) {
  const list = await hydrate();
  list.push({ id: crypto.randomUUID(), ts: Date.now(), ...entry });
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  scheduleFlush();
}

export async function getHistory() {
  // Block on any in-flight write so the history page never reads a stale
  // mirror immediately after a flush kicked off.
  if (inFlightWrite) await inFlightWrite;
  const list = await hydrate();
  // Return a copy — callers shouldn't be able to mutate the cached array.
  return list.slice();
}

export async function clearHistory() {
  cached = [];
  dirty = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await chrome.storage.local.remove([HISTORY_KEY]);
}
