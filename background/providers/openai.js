import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function openai({ apiKey, model, user, system, maxTokens, temperature, signal }) {
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
