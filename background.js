chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generate') {
    handleGenerate(request)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'explain') {
    handleExplain(request)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

const SYSTEM = 'You are a form-filling assistant. Output ONLY the value to insert into the field — no explanation, no preamble, no quotes, no markdown unless formatting is expected.';

function userMsg(label, userPrompt, pageTitle) {
  return `Page: "${pageTitle}"\nField: "${label}"\n${userPrompt ? `Instruction: ${userPrompt}` : 'Generate appropriate content for this field.'}`;
}

async function handleExplain({ kind, text, pageTitle }) {
  const settings = await new Promise(r => chrome.storage.sync.get(['provider', 'apiKey', 'model', 'ollamaBaseUrl'], r));
  const { provider, apiKey, model, ollamaBaseUrl } = settings;
  if (!provider) throw new Error('No provider configured. Open extension settings.');
  if (provider !== 'ollama' && !apiKey) throw new Error('API key not set. Open extension popup.');

  const systemPrompt = kind === 'word'
    ? 'You are a concise dictionary. Given a word, respond with: part of speech, definition (1-2 sentences), and a short example sentence. No preamble.'
    : 'You are a helpful explainer. Given selected text, explain it clearly in 2-3 sentences for a general audience. No preamble.';

  const userContent = kind === 'word'
    ? `Word: "${text}"\nPage context: "${pageTitle}"`
    : `Text: "${text}"\nPage context: "${pageTitle}"`;

  switch (provider) {
    case 'claude': return callClaude(apiKey, model, userContent, systemPrompt);
    case 'openai': return callOpenAI(apiKey, model, userContent, systemPrompt);
    case 'ollama': return callOllama(ollamaBaseUrl, model, userContent, systemPrompt);
    default: throw new Error('Unknown provider.');
  }
}

async function handleGenerate({ provider, apiKey, model, ollamaBaseUrl, label, prompt, pageTitle }) {
  const msg = userMsg(label, prompt, pageTitle);
  switch (provider) {
    case 'claude': return callClaude(apiKey, model, msg);
    case 'openai': return callOpenAI(apiKey, model, msg);
    case 'ollama': return callOllama(ollamaBaseUrl, model, msg);
    default: throw new Error('Unknown provider. Configure settings.');
  }
}

async function callClaude(apiKey, model, userContent, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 1024,
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

async function callOpenAI(apiKey, model, userContent, systemPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
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

async function callOllama(baseUrl, model, userContent, systemPrompt) {
  const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  // /api/chat with system+user roles — /api/generate (completion) causes models to echo the prompt
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
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
