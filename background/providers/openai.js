import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function openai({ apiKey, model, user, system, userProfile, maxTokens, temperature, stop, jsonSchema, signal, timeoutMs }) {
  // OpenAI does prefix-cache automatically (>1024 tokens), so keeping system
  // stable across calls maximizes hit rate. Profile appended at the tail
  // means the base prefix stays cacheable; profile edits only invalidate
  // the tail.
  const sys = userProfile?.trim()
    ? `${system}\n\nUser profile (use values from here when the field maps to profile data; never invent):\n${userProfile.trim()}`
    : system;
  // strict json_schema is the modern path; fall back to json_object for
  // older models that don't support schema-mode by hard-coding the looser
  // form. Both modes return JSON inside message.content so the caller can
  // treat the result like any text response.
  const responseFormat = jsonSchema
    ? { type: 'json_schema', json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema } }
    : null;

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
      ...(temperature != null ? { temperature } : {}),
      ...(stop?.length ? { stop } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: user }
      ]
    })
  }, timeoutMs);
  if (!res.ok) throw await extractError(res, 'OpenAI API');
  const data = await res.json();
  return data.choices[0].message.content.trim();
}
