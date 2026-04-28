import { callProvider } from './providers/index.js';
import { SYSTEM, TEMPERATURE, DEFINE_SCHEMA, FILL_FORM_SCHEMA, userMsg, explainPrompts, fillFormPrompts, tokensForField, tokensForExplain, stopForField, cleanFormOutput, cleanDefineOutput, cleanFillFormOutput } from './prompts.js';
import { appendHistory } from './lib/history.js';

// Pre-warm content.css into session storage so all frames share one fetch.
// chrome.storage.session is in-memory per browser session; default access is
// TRUSTED_CONTEXTS only, which would block content-script reads. Extending it
// to TRUSTED_AND_UNTRUSTED_CONTEXTS lets bootstrap.js read directly. Aide
// stores nothing sensitive in session — only the packaged CSS text — so
// granting content-script read access is safe; future expansions of session
// storage need to remember this is now content-readable.
async function warmContentCssCache() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch {}
  try {
    const res = await fetch(chrome.runtime.getURL('content/content.css'));
    if (!res.ok) return;
    const css = await res.text();
    await chrome.storage.session.set({ aideContentCss: css });
  } catch {}
}
// Top-level call covers SW cold starts (after spin-down/wake), which fire
// neither onInstalled nor onStartup. The two listeners cover fresh
// installs/updates and browser launches respectively.
warmContentCssCache();
chrome.runtime.onInstalled.addListener(warmContentCssCache);
chrome.runtime.onStartup.addListener(warmContentCssCache);

// Right-click on selected text → "Aide: Explain / Define". Lets users
// override the auto-popup's word/explain heuristic ("Define this multi-word
// phrase", "Explain this single word"), and gives an explicit invocation
// path on sites where the auto-popup is intentionally disabled.
function ensureContextMenus() {
  // removeAll → recreate is idempotent and avoids "duplicate id" errors on
  // dev reload. Items persist across SW restarts within an install, so we
  // only need this on install/update/browser-startup.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'aide-explain', title: 'Aide: Explain selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'aide-define',  title: 'Aide: Define selection',  contexts: ['selection'] });
  });
}
chrome.runtime.onInstalled.addListener(ensureContextMenus);
chrome.runtime.onStartup.addListener(ensureContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const kind = info.menuItemId === 'aide-define'  ? 'word'
             : info.menuItemId === 'aide-explain' ? 'explain'
             : null;
  if (!kind) return;
  // Scope to info.frameId — the user may have right-clicked inside an
  // iframe (Greenhouse boards, embedded forms). Without a frameId, the
  // message goes only to the top frame and the iframe's content script
  // never hears it.
  chrome.tabs.sendMessage(
    tab.id,
    { action: 'contextMenu', kind },
    { frameId: info.frameId },
    () => { void chrome.runtime.lastError; } // swallow "no receiver" if frame has no content script
  );
});

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
