import { claude } from './claude.js';
import { openai } from './openai.js';
import { gemini } from './gemini.js';
import { ollama } from './ollama.js';

const providers = { claude, openai, gemini, ollama };

export async function callProvider({ provider, ...cfg }, signal) {
  const fn = providers[provider];
  if (!fn) throw new Error('Unknown provider.');
  return fn({ ...cfg, signal });
}
