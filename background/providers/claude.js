import { fetchWithRetry } from '../lib/retry.js';
import { extractError } from '../lib/http.js';
import { readStreamLines } from '../lib/streaming.js';

export async function claude({ apiKey, model, user, system, userProfile, maxTokens, temperature, stop, jsonSchema, images, onDelta, signal, timeoutMs }) {
  // Claude has no JSON-mode flag; tool-use with tool_choice forces the model
  // to emit a tool_use block whose `input` is a JSON object matching the
  // declared schema. We extract that and stringify so callers see plain JSON.
  const tools = jsonSchema ? [{
    name: jsonSchema.name,
    description: 'Return structured output matching the schema.',
    input_schema: jsonSchema.schema
  }] : null;

  // Anthropic rejects whitespace-only stop sequences ("each stop sequence
  // must contain non-whitespace"). Filter them out; cleanFormOutput
  // truncates non-multiline fields to the first line anyway.
  const filteredStop = (stop || []).filter(s => s && s.trim().length > 0);

  // Stream when caller supplied an onDelta and we're not in tool-use mode.
  // Tool-use streaming would emit input_json_delta partials that aren't
  // useful for live painting, so we keep that path buffered.
  const stream = !!onDelta && !jsonSchema;

  const body = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    ...(temperature != null ? { temperature } : {}),
    ...(filteredStop.length ? { stop_sequences: filteredStop } : {}),
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
    // Anthropic accepts both `content: "<string>"` and an array of typed
    // blocks. The array form is required to interleave image + text for
    // vision calls; we keep the string shape for plain text so unrelated
    // calls don't change wire format (and stay diff-clean against caches).
    messages: [{
      role: 'user',
      content: images?.length
        ? [
            ...images.map(img => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
            })),
            { type: 'text', text: user }
          ]
        : user
    }],
    ...(stream ? { stream: true } : {})
  };

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  }, timeoutMs);
  if (!res.ok) throw await extractError(res, 'Claude API');

  if (stream) {
    let acc = '';
    await readStreamLines(res, line => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      try {
        const obj = JSON.parse(payload);
        if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
          const t = obj.delta.text || '';
          if (t) { acc += t; onDelta(t); }
        }
      } catch {}
    });
    return acc.trim();
  }

  const data = await res.json();
  if (jsonSchema) {
    const tool = (data.content || []).find(b => b.type === 'tool_use');
    if (tool?.input) return JSON.stringify(tool.input);
  }
  const text = (data.content || []).find(b => b.type === 'text');
  return (text?.text || '').trim();
}
