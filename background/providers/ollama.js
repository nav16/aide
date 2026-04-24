import { fetchWithRetry } from '../retry.js';

export async function ollama({ baseUrl, model, user, system, signal }) {
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
        { role: 'system', content: system },
        { role: 'user',   content: user }
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
