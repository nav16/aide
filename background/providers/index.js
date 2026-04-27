import { claude } from './claude.js';
import { openai } from './openai.js';
import { gemini } from './gemini.js';
import { ollama } from './ollama.js';

const providers = { claude, openai, gemini, ollama };

export async function callProvider({ provider, timeoutMs, ...cfg }, signal) {
  const fn = providers[provider];
  if (!fn) throw new Error('Unknown provider.');
  // Local Ollama is typically slow to first-token on big models; cloud
  // providers are usually <30s. Caller can override per-action.
  const effective = timeoutMs ?? (provider === 'ollama' ? 180000 : 60000);
  return fn({ ...cfg, signal, timeoutMs: effective });
}
