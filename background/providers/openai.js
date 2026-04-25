import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function openai({ apiKey, model, user, system, maxTokens, temperature, stop, jsonSchema, signal }) {
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
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ]
    })
  });
  if (!res.ok) throw await extractError(res, 'OpenAI API');
  const data = await res.json();
  return data.choices[0].message.content.trim();
}
