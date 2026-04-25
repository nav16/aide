import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function claude({ apiKey, model, user, system, maxTokens, temperature, stop, jsonSchema, signal }) {
  // Claude has no JSON-mode flag; tool-use with tool_choice forces the model
  // to emit a tool_use block whose `input` is a JSON object matching the
  // declared schema. We extract that and stringify so callers see plain JSON.
  const tools = jsonSchema ? [{
    name: jsonSchema.name,
    description: 'Return structured output matching the schema.',
    input_schema: jsonSchema.schema
  }] : null;

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
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
      ...(temperature != null ? { temperature } : {}),
      ...(stop?.length ? { stop_sequences: stop } : {}),
      ...(tools ? { tools, tool_choice: { type: 'tool', name: jsonSchema.name } } : {}),
      // Mark system prompt cacheable. System + (optional) tools are stable
      // across same-kind calls (form-fill, define, explain, followup), so
      // Anthropic returns a cache hit on the prefix and only bills the
      // user-message delta. ~90% input-cost cut on repeat calls.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) throw await extractError(res, 'Claude API');
  const data = await res.json();
  if (jsonSchema) {
    const tool = (data.content || []).find(b => b.type === 'tool_use');
    if (tool?.input) return JSON.stringify(tool.input);
  }
  const text = (data.content || []).find(b => b.type === 'text');
  return (text?.text || '').trim();
}
