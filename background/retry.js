// One retry with short backoff on network errors, 429, and 5xx. Covers the
// most common flakes (rate-limit spikes, gateway timeouts, brief net drops)
// without turning a hard failure into a long hang.

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    function onAbort() { clearTimeout(t); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchWithRetry(url, options) {
  const signal = options?.signal;
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    await sleep(500, signal);
    return fetch(url, options);
  }
  const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
  if (!transient) return res;
  let delay = res.status === 429 ? 1000 : 750;
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    const secs = ra ? parseInt(ra, 10) : NaN;
    if (!isNaN(secs)) delay = Math.min(secs * 1000, 5000);
  }
  await sleep(delay, signal);
  return fetch(url, options);
}
