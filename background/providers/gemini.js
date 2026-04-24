import { fetchWithRetry } from '../retry.js';
import { extractError } from '../http.js';

export async function gemini({ apiKey, model, user, system, signal }) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3-flash-preview'}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }]
      })
    }
  );
  if (!res.ok) throw await extractError(res, 'Gemini API');
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}
