const explainControllers = new Map();

// ---- Non-streaming message handler ----

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

// ---- Streaming port handler ----

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'stream') return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async request => {
    try {
      const gen = buildStreamGen(request, controller.signal);
      for await (const chunk of gen) {
        if (controller.signal.aborted) return;
        try { port.postMessage({ chunk }); } catch { return; }
      }
      try { port.postMessage({ done: true }); } catch {}
    } catch (err) {
      if (err.name === 'AbortError') return;
      try { port.postMessage({ error: err.message }); } catch {}
    }
  });
});

// ---- Shared constants & helpers ----

const SYSTEM = 'You are a form-filling assistant. Output ONLY the value to insert into the field — no explanation, no preamble, no quotes, no markdown unless formatting is expected.';

const MAX_TOKENS = { form: 256, explain: 512 };

function userMsg(label, userPrompt, pageTitle) {
  return `Page: "${pageTitle}"\nField: "${label}"\n${userPrompt ? `Instruction: ${userPrompt}` : 'Generate appropriate content for this field.'}`;
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

// ---- Non-streaming handlers ----

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

async function handleGenerate({ provider, apiKey, model, ollamaBaseUrl, label, prompt, pageTitle }) {
  const msg = userMsg(label, prompt, pageTitle);
  switch (provider) {
    case 'claude': return callClaude(apiKey, model, msg, undefined, MAX_TOKENS.form);
    case 'openai': return callOpenAI(apiKey, model, msg, undefined, MAX_TOKENS.form);
    case 'gemini': return callGemini(apiKey, model, msg);
    case 'ollama': return callOllama(ollamaBaseUrl, model, msg);
    default: throw new Error('Unknown provider. Configure settings.');
  }
}

// ---- Streaming dispatch ----

function buildStreamGen(request, signal) {
  const { provider, apiKey, model, ollamaBaseUrl } = request;
  let userContent, systemPrompt, maxTokens;

  if (request.action === 'generate') {
    userContent  = userMsg(request.label, request.prompt, request.pageTitle);
    systemPrompt = undefined;
    maxTokens    = MAX_TOKENS.form;
  } else {
    const p = explainPrompts(request.kind, request.text, request.pageTitle);
    userContent  = p.user;
    systemPrompt = p.system;
    maxTokens    = MAX_TOKENS.explain;
  }

  switch (provider) {
    case 'claude': return streamClaude(apiKey, model, userContent, systemPrompt, maxTokens, signal);
    case 'openai': return streamOpenAI(apiKey, model, userContent, systemPrompt, maxTokens, signal);
    case 'gemini': return streamGeminiAsGen(apiKey, model, userContent, systemPrompt, signal);
    case 'ollama': return streamOllama(ollamaBaseUrl, model, userContent, systemPrompt, signal);
    default: throw new Error('Unknown provider.');
  }
}

async function* streamGeminiAsGen(apiKey, model, userContent, systemPrompt, signal) {
  // Gemini streaming format is complex; yield single-shot response as one chunk
  const text = await callGemini(apiKey, model, userContent, systemPrompt, signal);
  yield text;
}

// ---- SSE helper ----

async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data !== '[DONE]') yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- Streaming generators ----

async function* streamClaude(apiKey, model, userContent, systemPrompt, maxTokens = MAX_TOKENS.form, signal) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
      stream: true,
      system: systemPrompt || SYSTEM,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error ${res.status}`);
  }
  for await (const data of readSSE(res)) {
    if (signal?.aborted) return;
    try {
      const p = JSON.parse(data);
      if (p.type === 'content_block_delta' && p.delta?.type === 'text_delta' && p.delta.text) {
        yield p.delta.text;
      }
    } catch {}
  }
}

async function* streamOpenAI(apiKey, model, userContent, systemPrompt, maxTokens = MAX_TOKENS.form, signal) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      max_tokens: maxTokens,
      stream: true,
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
  for await (const data of readSSE(res)) {
    if (signal?.aborted) return;
    try {
      const p = JSON.parse(data);
      const text = p.choices?.[0]?.delta?.content;
      if (text) yield text;
    } catch {}
  }
}

async function* streamOllama(baseUrl, model, userContent, systemPrompt, signal) {
  const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt || SYSTEM },
        { role: 'user',   content: userContent }
      ]
    })
  });
  if (res.status === 403) {
    throw new Error('Ollama blocked (403). Restart with OLLAMA_ORIGINS="*" — e.g. OLLAMA_ORIGINS="*" ollama serve');
  }
  if (!res.ok) throw new Error(`Ollama error ${res.status}. Is Ollama running at ${base}?`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          if (p.message?.content) yield p.message.content;
          if (p.done) return;
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- Non-streaming fetch functions ----

async function callClaude(apiKey, model, userContent, systemPrompt, maxTokens = MAX_TOKENS.form, signal) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  const res = await fetch(
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
  const res = await fetch(`${base}/api/chat`, {
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
