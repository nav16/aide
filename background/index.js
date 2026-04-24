import { callProvider } from './providers/index.js';
import { SYSTEM, MAX_TOKENS, userMsg, explainPrompts } from './prompts.js';

const explainControllers  = new Map();
const generateControllers = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generate') {
    const controller = new AbortController();
    if (request.reqId != null) generateControllers.set(request.reqId, controller);
    handleGenerate(request, controller.signal)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => {
        if (err.name === 'AbortError') return;
        sendResponse({ success: false, error: err.message });
      })
      .finally(() => { if (request.reqId != null) generateControllers.delete(request.reqId); });
    return true;
  }
  if (request.action === 'explain') {
    const controller = new AbortController();
    explainControllers.set(request.reqId, controller);
    handleExplain(request, controller.signal)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => {
        if (err.name === 'AbortError') return;
        sendResponse({ success: false, error: err.message });
      })
      .finally(() => explainControllers.delete(request.reqId));
    return true;
  }
  if (request.action === 'cancelExplain') {
    explainControllers.get(request.reqId)?.abort();
    explainControllers.delete(request.reqId);
  }
  if (request.action === 'cancelGenerate') {
    generateControllers.get(request.reqId)?.abort();
    generateControllers.delete(request.reqId);
  }
});

async function handleGenerate(req, signal) {
  if (!req.provider) throw new Error('No provider configured. Open extension settings.');
  if (req.provider !== 'ollama' && !req.apiKey) throw new Error('API key not set. Open extension popup.');
  const user = userMsg(req.label, req.prompt, req.pageTitle, req.constraints);
  return callProvider({
    provider: req.provider,
    apiKey:   req.apiKey,
    model:    req.model,
    baseUrl:  req.ollamaBaseUrl,
    user,
    system:    SYSTEM,
    maxTokens: MAX_TOKENS.form
  }, signal);
}

async function handleExplain(req, signal) {
  if (!req.provider) throw new Error('No provider configured. Open extension settings.');
  if (req.provider !== 'ollama' && !req.apiKey) throw new Error('API key not set. Open extension popup.');
  const { system, user } = explainPrompts(req.kind, req.text, req.pageTitle, req.context);
  return callProvider({
    provider: req.provider,
    apiKey:   req.apiKey,
    model:    req.model,
    baseUrl:  req.ollamaBaseUrl,
    user,
    system,
    maxTokens: MAX_TOKENS.explain
  }, signal);
}
