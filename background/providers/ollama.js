import { fetchWithRetry } from '../retry.js';

export async function ollama({ baseUrl, model, user, system, userProfile, maxTokens, temperature, stop, jsonSchema, signal, timeoutMs }) {
  const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  // Append profile to system. Ollama has no prompt-cache concept like Anthropic,
  // so a single combined system string is simplest. Skipped when empty.
  const sys = userProfile?.trim()
    ? `${system}\n\nUser profile (use values from here when the field maps to profile data; never invent):\n${userProfile.trim()}`
    : system;
  // num_ctx default is 2048 — long page selections + transcripts get silently
  // truncated. 8192 covers our worst-case prompts without bloating VRAM for
  // most local models. num_predict caps generation; without it Ollama runs
  // until the model decides to stop, which can hang on rambling outputs.
  // keep_alive holds the model in memory so subsequent calls skip the cold-load.
  const options = {
    num_ctx: 8192,
    ...(maxTokens   != null ? { num_predict: maxTokens } : {}),
    ...(temperature != null ? { temperature }            : {}),
    ...(stop?.length        ? { stop }                   : {})
  };
  const res = await fetchWithRetry(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: '10m',
      // Ollama supports two json modes: format:'json' (free-form JSON) and
      // format:<schema> (constrained — requires recent Ollama). The schema
      // form is more reliable; falls back to plain 'json' if no schema given.
      ...(jsonSchema ? { format: jsonSchema.schema } : {}),
      options,
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: user }
      ]
    })
  }, timeoutMs);
  if (res.status === 403) {
    throw new Error('Ollama blocked (403). Restart with OLLAMA_ORIGINS="*" — e.g. OLLAMA_ORIGINS="*" ollama serve');
  }
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}. Is Ollama running at ${base}?`);
  }
  const data = await res.json();
  return data.message.content.trim();
}
