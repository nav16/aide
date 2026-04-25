import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function gemini({ apiKey, model, user, system, maxTokens, temperature, stop, jsonSchema, signal }) {
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
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3-flash-preview'}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {})
      })
    }
  );
  if (!res.ok) throw await extractError(res, 'Gemini API');
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    out[k] = (k === 'properties' || k === 'items') ? sanitizeSchemaForGemini(v) : v;
  }
  return out;
}
