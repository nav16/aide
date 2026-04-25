import { fetchWithRetry } from '../retry.js';

export async function ollama({ baseUrl, model, user, system, temperature, stop, jsonSchema, signal }) {
  const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  // /api/chat with system+user roles — /api/generate (completion) causes models to echo the prompt
  const res = await fetchWithRetry(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      // Ollama supports two json modes: format:'json' (free-form JSON) and
      // format:<schema> (constrained — requires recent Ollama). The schema
      // form is more reliable; falls back to plain 'json' if no schema given.
      ...(jsonSchema ? { format: jsonSchema.schema } : {}),
      ...((temperature != null || stop?.length)
        ? { options: { ...(temperature != null ? { temperature } : {}), ...(stop?.length ? { stop } : {}) } }
        : {}),
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
