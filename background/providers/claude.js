import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function claude({ apiKey, model, user, system, maxTokens, temperature, stop, signal }) {
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
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) throw await extractError(res, 'Claude API');
  const data = await res.json();
  return data.content[0].text.trim();
}
