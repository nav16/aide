// One retry with short backoff on network errors, 429, and 5xx. Covers the
// most common flakes (rate-limit spikes, gateway timeouts, brief net drops)
// without turning a hard failure into a long hang.
//
// Each fetch attempt also gets its own per-request timeout — without this,
// a stalled provider can hang for minutes (especially Ollama on a heavy
// model) even though the extension popup looks responsive.

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    function onAbort() { clearTimeout(t); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Build a per-attempt signal that aborts when (a) the caller's signal aborts
// (user dismissed the UI), or (b) the timeout fires. Returned cleanup
// function stops the timer and unhooks the listener so we don't leak.
function makeAttemptSignal(userSignal, timeoutMs) {
  const ctl = new AbortController();
  if (userSignal?.aborted) {
    ctl.abort(userSignal.reason);
    return { signal: ctl.signal, cleanup: () => {} };
  }
  const onUserAbort = () => ctl.abort(userSignal.reason);
  userSignal?.addEventListener('abort', onUserAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', onUserAbort);
  };
  return { signal: ctl.signal, cleanup };
}

export async function fetchWithRetry(url, options, timeoutMs = 60000) {
  const userSignal = options?.signal;
  // Strip the caller's signal so we can substitute our composed signal per
  // attempt. Otherwise the caller's signal would override our timeout signal.
  const { signal: _drop, ...rest } = options || {};

  const attempt = async () => {
    const { signal, cleanup } = makeAttemptSignal(userSignal, timeoutMs);
    try { return await fetch(url, { ...rest, signal }); }
    finally { cleanup(); }
  };

  // Translate a generic AbortError into the right thing for the caller: a
  // user-initiated cancel propagates as-is so callers can suppress it,
  // whereas a timeout becomes a regular Error with a clear message.
  const classify = (err) => {
    if (err?.name !== 'AbortError') return err;
    if (userSignal?.aborted) return err;
    const e = new Error('Request timed out. Try again or pick a faster model.');
    e.name = 'TimeoutError';
    return e;
  };

  let res;
  try {
    res = await attempt();
  } catch (err) {
    const e = classify(err);
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
    // Network glitch — short backoff, then one retry.
    await sleep(500, userSignal);
    try { return await attempt(); }
    catch (err2) { throw classify(err2); }
  }
  const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
  if (!transient) return res;
  let delay = res.status === 429 ? 1000 : 750;
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    const secs = ra ? parseInt(ra, 10) : NaN;
    if (!isNaN(secs)) delay = Math.min(secs * 1000, 5000);
  }
  await sleep(delay, userSignal);
  try { return await attempt(); }
  catch (err) { throw classify(err); }
}
