import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function claude({ apiKey, model, user, system, userProfile, maxTokens, temperature, stop, jsonSchema, signal }) {
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
      // Anthropic rejects whitespace-only stop sequences ("each stop sequence
      // must contain non-whitespace"). Filter them out; cleanFormOutput
      // truncates non-multiline fields to the first line anyway.
      ...((() => {
        const filtered = (stop || []).filter(s => s && s.trim().length > 0);
        return filtered.length ? { stop_sequences: filtered } : {};
      })()),
      ...(tools ? { tools, tool_choice: { type: 'tool', name: jsonSchema.name } } : {}),
      // Mark system prompt cacheable. System + (optional) tools are stable
      // across same-kind calls (form-fill, define, explain, followup), so
      // Anthropic returns a cache hit on the prefix and only bills the
      // user-message delta. ~90% input-cost cut on repeat calls.
      //
      // When a userProfile is set, append it as a SECOND cacheable block.
      // Two cache_control breakpoints means a profile edit only invalidates
      // the tail block — the base SYSTEM prefix stays hot. Profile is
      // re-billed once per change, then cached across every subsequent call.
      system: (() => {
        const blocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
        const profile = (userProfile || '').trim();
        if (profile) {
          blocks.push({
            type: 'text',
            text: `User profile (use values from here when the field maps to profile data; never invent):\n${profile}`,
            cache_control: { type: 'ephemeral' }
          });
        }
        return blocks;
      })(),
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
