import { fetchWithRetry } from '../lib/retry.js';
import { extractError } from '../lib/http.js';
import { readStreamLines } from '../lib/streaming.js';

export async function gemini({ apiKey, model, user, system, userProfile, maxTokens, temperature, stop, jsonSchema, onDelta, signal, timeoutMs }) {
  // Gemini's implicit caching keys off the request prefix; keeping system
  // stable across calls + appending the profile at the tail preserves the
  // cacheable prefix and only the profile portion changes per-user.
  const sys = userProfile?.trim()
    ? `${system}\n\nUser profile (use values from here when the field maps to profile data; never invent):\n${userProfile.trim()}`
    : system;
  const generationConfig = {};
  if (maxTokens   != null) generationConfig.maxOutputTokens = maxTokens;
  if (temperature != null) generationConfig.temperature     = temperature;
  if (stop?.length)        generationConfig.stopSequences   = stop;
  if (jsonSchema) {
    // Gemini's responseSchema follows an OpenAPI subset that rejects
    // additionalProperties and $schema. Strip those before send; type,
    // description, properties, items, required, enum are all supported.
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema   = sanitizeSchemaForGemini(jsonSchema.schema);
  }

  // Stream when caller asked for deltas and we're not in JSON-mode (partial
  // JSON would render badly mid-stream).
  const stream = !!onDelta && !jsonSchema;
  const path = stream ? 'streamGenerateContent' : 'generateContent';
  // alt=sse switches the streaming response from a JSON array of chunks to
  // a proper Server-Sent Events stream — same line-format the other two
  // cloud providers emit, so readStreamLines covers it cleanly.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3-flash-preview'}:${path}?${stream ? 'alt=sse&' : ''}key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ parts: [{ text: user }] }],
      ...(Object.keys(generationConfig).length ? { generationConfig } : {})
    })
  }, timeoutMs);
  if (!res.ok) throw await extractError(res, 'Gemini API');

  if (stream) {
    let acc = '';
    await readStreamLines(res, line => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      try {
        const obj = JSON.parse(payload);
        const parts = obj.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.text) { acc += p.text; onDelta(p.text); }
        }
      } catch {}
    });
    return acc.trim();
  }

  const data = await res.json();
  // Gemini can split a single response across multiple parts (especially
  // with responseMimeType=json + thinking models that emit a prose lead-in
  // separate from the JSON body). Concat all part texts so we never drop
  // the actual JSON payload.
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

function sanitizeSchemaForGemini(schema) {
  // Deep-walk every value: Gemini's OpenAPI subset rejects keys like
  // additionalProperties / $schema at any nesting depth. Earlier impl only
  // recursed when the *key name* was 'properties' or 'items', so a
  // sibling like fillForm's `properties.fills.items.additionalProperties`
  // slipped through and produced a 400 ("Unknown name 'additionalProperties'
  // at ...response_schema.properties[0].value.items").
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    out[k] = sanitizeSchemaForGemini(v);
  }
  return out;
}
