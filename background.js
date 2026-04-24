const explainControllers = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generate') {
    handleGenerate(request)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'explain') {
    const controller = new AbortController();
    explainControllers.set(request.reqId, controller);
    handleExplain(request, controller.signal)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => {
        if (err.name === 'AbortError') return;
        sendResponse({ success: false, error: err.message });
      })
      .finally(() => explainControllers.delete(request.reqId));
    return true;
  }
  if (request.action === 'cancelExplain') {
    explainControllers.get(request.reqId)?.abort();
    explainControllers.delete(request.reqId);
  }
});

// ---- Constants & helpers ----

const SYSTEM = 'You are a form-filling assistant. Output ONLY the value to insert into the field — no explanation, no preamble, no quotes, no markdown unless formatting is expected.';

const MAX_TOKENS = { form: 256, explain: 512 };

function userMsg(label, userPrompt, pageTitle, constraints) {
  let msg = `Page: "${pageTitle}"\nField: "${label}"\n`;
  if (constraints?.maxChars) msg += `Max characters: ${constraints.maxChars}\n`;
  if (constraints?.minChars) msg += `Min characters: ${constraints.minChars}\n`;
  msg += userPrompt ? `Instruction: ${userPrompt}` : 'Generate appropriate content for this field.';
  return msg;
}

function explainPrompts(kind, text, pageTitle) {
  return {
    system: kind === 'word'
      ? 'You are a concise dictionary. Given a word, respond with: part of speech, definition (1-2 sentences), and a short example sentence. No preamble.'
      : 'You are a helpful explainer. Given selected text, explain it clearly in 2-3 sentences for a general audience. No preamble.',
    user: kind === 'word'
      ? `Word: "${text}"\nPage context: "${pageTitle}"`
      : `Text: "${text}"\nPage context: "${pageTitle}"`
  };
}

// ---- Handlers ----

async function handleExplain({ kind, text, pageTitle, provider, apiKey, model, ollamaBaseUrl }, signal) {
  if (!provider) throw new Error('No provider configured. Open extension settings.');
  if (provider !== 'ollama' && !apiKey) throw new Error('API key not set. Open extension popup.');
  const { system, user } = explainPrompts(kind, text, pageTitle);
  switch (provider) {
    case 'claude': return callClaude(apiKey, model, user, system, MAX_TOKENS.explain, signal);
    case 'openai': return callOpenAI(apiKey, model, user, system, MAX_TOKENS.explain, signal);
    case 'gemini': return callGemini(apiKey, model, user, system, signal);
    case 'ollama': return callOllama(ollamaBaseUrl, model, user, system, signal);
    default: throw new Error('Unknown provider.');
  }
}

async function handleGenerate({ provider, apiKey, model, ollamaBaseUrl, label, prompt, pageTitle, constraints }) {
  const msg = userMsg(label, prompt, pageTitle, constraints);
  switch (provider) {
    case 'claude': return callClaude(apiKey, model, msg, undefined, MAX_TOKENS.form);
    case 'openai': return callOpenAI(apiKey, model, msg, undefined, MAX_TOKENS.form);
    case 'gemini': return callGemini(apiKey, model, msg);
    case 'ollama': return callOllama(ollamaBaseUrl, model, msg);
    default: throw new Error('Unknown provider. Configure settings.');
  }
}

// ---- Transient-failure retry ----

// One retry with short backoff on network errors, 429, and 5xx. Covers the
// most common flakes (rate-limit spikes, gateway timeouts, brief net drops)
// without turning a hard failure into a long hang.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    function onAbort() { clearTimeout(t); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithRetry(url, options) {
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

// ---- Fetch functions ----

async function callClaude(apiKey, model, userContent, systemPrompt, maxTokens = MAX_TOKENS.form, signal) {
  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt || SYSTEM,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error ${res.status}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

async function callOpenAI(apiKey, model, userContent, systemPrompt, maxTokens = MAX_TOKENS.form, signal) {
  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt || SYSTEM },
        { role: 'user',   content: userContent }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error ${res.status}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

async function callGemini(apiKey, model, userContent, systemPrompt, signal) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3-flash-preview'}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt || SYSTEM }] },
        contents: [{ parts: [{ text: userContent }] }]
      })
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API error ${res.status}`);
  }
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

async function callOllama(baseUrl, model, userContent, systemPrompt, signal) {
  const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  // /api/chat with system+user roles — /api/generate (completion) causes models to echo the prompt
  const res = await fetchWithRetry(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt || SYSTEM },
        { role: 'user',   content: userContent }
      ]
    })
  });
  if (res.status === 403) {
    throw new Error('Ollama blocked (403). Restart with OLLAMA_ORIGINS="*" — e.g. OLLAMA_ORIGINS="*" ollama serve');
  }
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}. Is Ollama running at ${base}?`);
  }
  const data = await res.json();
  return data.message.content.trim();
}
