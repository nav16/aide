import { callProvider } from './providers/index.js';
import { SYSTEM, MAX_TOKENS, TEMPERATURE, DEFINE_SCHEMA, userMsg, explainPrompts, tokensForField, stopForField, cleanFormOutput } from './prompts.js';

const explainControllers  = new Map();
const generateControllers = new Map();

// Both generate and explain require reqId — UI always sets one, and we need
// it to wire up cancellation. Reject early if missing rather than half-track
// a request we can't cancel.
function start(controllers, request, handler, sendResponse) {
  if (request.reqId == null) {
    sendResponse({ success: false, error: 'Internal: missing reqId.' });
    return true;
  }
  const controller = new AbortController();
  controllers.set(request.reqId, controller);
  handler(request, controller.signal)
    .then(text => sendResponse({ success: true, text }))
    .catch(err => {
      if (err.name === 'AbortError') return;
      sendResponse({ success: false, error: err.message });
    })
    .finally(() => controllers.delete(request.reqId));
  return true;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generate') return start(generateControllers, request, handleGenerate, sendResponse);
  if (request.action === 'explain')  return start(explainControllers,  request, handleExplain,  sendResponse);
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
  const user = userMsg(req.fieldContext, req.prompt, req.pageTitle);
  const raw = await callProvider({
    provider: req.provider,
    apiKey:   req.apiKey,
    model:    req.model,
    baseUrl:  req.ollamaBaseUrl,
    user,
    system:      SYSTEM,
    maxTokens:   tokensForField(req.fieldContext),
    temperature: TEMPERATURE.form,
    stop:        stopForField(req.fieldContext)
  }, signal);
  return cleanFormOutput(raw, req.fieldContext);
}

async function handleExplain(req, signal) {
  if (!req.provider) throw new Error('No provider configured. Open extension settings.');
  if (req.provider !== 'ollama' && !req.apiKey) throw new Error('API key not set. Open extension popup.');
  const { system, user } = explainPrompts(req.kind, req.text, req.pageTitle, req.context, req.hostname);
  return callProvider({
    provider: req.provider,
    apiKey:   req.apiKey,
    model:    req.model,
    baseUrl:  req.ollamaBaseUrl,
    user,
    system,
    maxTokens:   MAX_TOKENS[req.kind] || MAX_TOKENS.explain,
    temperature: req.kind === 'followup' ? TEMPERATURE.followup : TEMPERATURE.explain,
    // Native structured-output mode for define. Each provider wires this to
    // its own JSON-mode mechanism (json_schema / responseSchema / tool-use /
    // format:'json'). Returns a JSON string that the popup parses as before.
    jsonSchema:  req.kind === 'word' ? { name: 'define', schema: DEFINE_SCHEMA } : null
  }, signal);
}
