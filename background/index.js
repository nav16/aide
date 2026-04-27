import { callProvider } from './providers/index.js';
import { SYSTEM, TEMPERATURE, DEFINE_SCHEMA, FILL_FORM_SCHEMA, userMsg, explainPrompts, fillFormPrompts, tokensForField, tokensForExplain, stopForField, cleanFormOutput, cleanDefineOutput, cleanFillFormOutput } from './prompts.js';
import { appendHistory } from './history.js';

// Today's date is prepended to every system prompt so the model can resolve
// time-relative fields ("today", "next Friday", "year of birth assuming I'm
// 30") instead of falling back to its training cutoff. Day-of-week helps with
// "next Monday"-style reasoning. Re-evaluated per request, so the SW
// surviving across midnight still produces a fresh date.
function withTodayDate(system) {
  const d = new Date();
  const iso = d.toISOString().slice(0, 10);
  const dow = d.toLocaleDateString('en-US', { weekday: 'long' });
  return `Today: ${iso} (${dow})\n${system}`;
}

const explainControllers  = new Map();
const generateControllers = new Map();
const fillFormControllers = new Map();

// Both generate and explain require reqId — UI always sets one, and we need
// it to wire up cancellation. Reject early if missing rather than half-track
// a request we can't cancel.
function start(controllers, request, handler, sendResponse, recordFn) {
  if (request.reqId == null) {
    sendResponse({ success: false, error: 'Internal: missing reqId.' });
    return true;
  }
  const controller = new AbortController();
  controllers.set(request.reqId, controller);
  handler(request, controller.signal)
    .then(text => {
      sendResponse({ success: true, text });
      if (recordFn) {
        // Fire-and-forget — history failures must not surface to the user;
        // their request already succeeded.
        Promise.resolve()
          .then(() => appendHistory(recordFn(request, text)))
          .catch(() => {});
      }
    })
    .catch(err => {
      if (err.name === 'AbortError') return;
      sendResponse({ success: false, error: err.message });
    })
    .finally(() => controllers.delete(request.reqId));
  return true;
}

function generateRecord(req, text) {
  return {
    kind: 'generate',
    hostname: req.hostname || '',
    pageTitle: req.pageTitle || '',
    provider: req.provider,
    model: req.model,
    input: {
      fieldLabel: req.fieldContext?.label || '',
      maxChars:   req.fieldContext?.maxChars || null,
      prompt:     req.prompt || ''
    },
    output: text
  };
}

function explainRecord(req, text) {
  return {
    kind: req.kind, // 'word' | 'explain' | 'followup'
    hostname: req.hostname || '',
    pageTitle: req.pageTitle || '',
    provider: req.provider,
    model: req.model,
    input: {
      text: req.text || '',
      originalText: req.context?.originalText || '',
      surrounding:  req.context?.surrounding  || ''
    },
    output: text
  };
}

function fillFormRecord(req, text) {
  return {
    kind: 'fillForm',
    hostname: req.hostname || '',
    pageTitle: req.pageTitle || '',
    provider: req.provider,
    model: req.model,
    input: {
      fields: (req.fields || []).map(f => ({ key: f.key, label: f.label, maxChars: f.maxChars || null }))
    },
    output: text
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generate') return start(generateControllers, request, handleGenerate, sendResponse, generateRecord);
  if (request.action === 'explain')  return start(explainControllers,  request, handleExplain,  sendResponse, explainRecord);
  if (request.action === 'fillForm') return start(fillFormControllers, request, handleFillForm, sendResponse, fillFormRecord);
  if (request.action === 'cancelExplain') {
    explainControllers.get(request.reqId)?.abort();
    explainControllers.delete(request.reqId);
  }
  if (request.action === 'cancelGenerate') {
    generateControllers.get(request.reqId)?.abort();
    generateControllers.delete(request.reqId);
  }
  if (request.action === 'cancelFillForm') {
    fillFormControllers.get(request.reqId)?.abort();
    fillFormControllers.delete(request.reqId);
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
    system:      withTodayDate(SYSTEM),
    // Profile rides as a separate input — Anthropic puts it in a 2nd cached
    // system block, others append to the system text. Keeps the SYSTEM
    // prefix cacheable across users and profile changes.
    userProfile: req.userProfile,
    maxTokens:   tokensForField(req.fieldContext),
    temperature: TEMPERATURE.form,
    stop:        stopForField(req.fieldContext),
    timeoutMs:   60000
  }, signal);
  return cleanFormOutput(raw, req.fieldContext);
}

async function handleFillForm(req, signal) {
  if (!req.provider) throw new Error('No provider configured. Open extension settings.');
  if (req.provider !== 'ollama' && !req.apiKey) throw new Error('API key not set. Open extension popup.');
  if (!Array.isArray(req.fields) || req.fields.length === 0) throw new Error('No fields to fill.');
  const { system, user } = fillFormPrompts(req.fields, req.pageTitle, req.hostname);
  // Headroom per field: ~80 tokens covers typical short values; long-form
  // textareas in the form get clipped by the model honoring maxChars anyway.
  const maxTokens = Math.min(2048, 64 + req.fields.length * 80);
  const raw = await callProvider({
    provider: req.provider,
    apiKey:   req.apiKey,
    model:    req.model,
    baseUrl:  req.ollamaBaseUrl,
    user,
    system:      withTodayDate(system),
    userProfile: req.userProfile,
    maxTokens,
    temperature: TEMPERATURE.form,
    jsonSchema: { name: 'fillForm', schema: FILL_FORM_SCHEMA },
    timeoutMs:   90000
  }, signal);
  return cleanFillFormOutput(raw);
}

async function handleExplain(req, signal, onDelta) {
  if (!req.provider) throw new Error('No provider configured. Open extension settings.');
  if (req.provider !== 'ollama' && !req.apiKey) throw new Error('API key not set. Open extension popup.');
  const { system, user } = explainPrompts(req.kind, req.text, req.pageTitle, req.context, req.hostname);
  const raw = await callProvider({
    provider: req.provider,
    apiKey:   req.apiKey,
    model:    req.model,
    baseUrl:  req.ollamaBaseUrl,
    user,
    system:      withTodayDate(system),
    maxTokens:   tokensForExplain(req.kind, req.text),
    temperature: TEMPERATURE[req.kind] ?? TEMPERATURE.explain,
    // Native structured-output mode for define. Each provider wires this to
    // its own JSON-mode mechanism (json_schema / responseSchema / tool-use /
    // format:'json'). Returns a JSON string that the popup parses as before.
    jsonSchema:  req.kind === 'word' ? { name: 'define', schema: DEFINE_SCHEMA } : null,
    // Live-streaming for prose answers. Providers ignore onDelta when
    // jsonSchema is set so define stays buffered (partial JSON is useless
    // to paint).
    onDelta,
    timeoutMs:   60000
  }, signal);
  return req.kind === 'word' ? cleanDefineOutput(raw) : raw;
}

// Streaming transport for explain/word/followup. Each call gets its own
// long-lived port so the SW can push delta + done frames back without
// keeping a sendResponse callback alive. Disconnecting the port from the
// content side aborts the in-flight provider call.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'aide-stream') return;
  const controller = new AbortController();
  let started = false;

  port.onMessage.addListener(async msg => {
    if (msg?.action === 'cancel') { controller.abort(); return; }
    if (started) return;          // ignore extra start frames per port
    started = true;
    if (msg?.action !== 'explain') {
      try { port.postMessage({ type: 'error', error: 'Unknown stream action.' }); } catch {}
      try { port.disconnect(); } catch {}
      return;
    }
    const onDelta = (text) => {
      try { port.postMessage({ type: 'delta', text }); } catch {}
    };
    try {
      const text = await handleExplain(msg, controller.signal, onDelta);
      try { port.postMessage({ type: 'done', text }); } catch {}
      Promise.resolve()
        .then(() => appendHistory(explainRecord(msg, text)))
        .catch(() => {});
    } catch (err) {
      if (err.name === 'AbortError') return;
      try { port.postMessage({ type: 'error', error: err.message }); } catch {}
    } finally {
      try { port.disconnect(); } catch {}
    }
  });

  port.onDisconnect.addListener(() => { controller.abort(); });
});
