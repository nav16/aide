// Iterate the response body line-by-line. Used by every provider's streaming
// branch — Anthropic / OpenAI / Gemini all use newline-delimited SSE, and
// Ollama emits NDJSON which is also line-delimited.
//
// Buffers across reads so a chunk that splits a line mid-payload doesn't
// drop or corrupt that payload.
export async function readStreamLines(res, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf);
}
