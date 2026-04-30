import { fetchWithRetry } from '../lib/retry.js';
import { readStreamLines } from '../lib/streaming.js';

export async function ollama({ baseUrl, model, user, system, userProfile, maxTokens, temperature, stop, jsonSchema, images, onDelta, signal, timeoutMs }) {
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

  // Stream when an onDelta hook is provided and we're not constraining to a
  // schema. Ollama's NDJSON stream is one JSON object per line with a final
  // {done:true} marker; readStreamLines handles the line-splitting.
  const stream = !!onDelta && !jsonSchema;

  const res = await fetchWithRetry(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream,
      keep_alive: '10m',
      // Ollama supports two json modes: format:'json' (free-form JSON) and
      // format:<schema> (constrained — requires recent Ollama). The schema
      // form is more reliable; falls back to plain 'json' if no schema given.
      ...(jsonSchema ? { format: jsonSchema.schema } : {}),
      options,
      // Vision: Ollama's chat API takes an `images` array of raw base64
      // strings (no data: prefix, no mime type) on the user message. Only
      // models with vision weights — llava, llama3.2-vision, qwen2-vl etc.
      // — actually consume them; text-only models will silently ignore the
      // attachment, which is why a non-vision local model would say
      // "please provide the image". Surfacing that as a friendly error
      // belongs in the popup model gate, not here.
      messages: [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: user,
          ...(images?.length ? { images: images.map(img => img.base64) } : {})
        }
      ]
    })
  }, timeoutMs);
  if (res.status === 403) {
    throw new Error('Ollama blocked (403). Restart with OLLAMA_ORIGINS="*" — e.g. OLLAMA_ORIGINS="*" ollama serve');
  }
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}. Is Ollama running at ${base}?`);
  }

  if (stream) {
    let acc = '';
    await readStreamLines(res, line => {
      try {
        const obj = JSON.parse(line);
        const delta = obj.message?.content;
        if (delta) { acc += delta; onDelta(delta); }
      } catch {}
    });
    return acc.trim();
  }

  const data = await res.json();
  return data.message.content.trim();
}
