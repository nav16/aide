'use strict';

const STATIC_MODELS = {
  claude: [
    { value: 'claude-sonnet-4-6',         label: 'Sonnet 4.6  —  recommended' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5  —  fast' },
    { value: 'claude-opus-4-7',           label: 'Opus 4.7   —  powerful' }
  ],
  openai: [
    { value: 'gpt-4o',       label: 'GPT-4o        —  recommended' },
    { value: 'gpt-4o-mini',  label: 'GPT-4o Mini  —  fast' },
    { value: 'gpt-4-turbo',  label: 'GPT-4 Turbo  —  legacy' }
  ],
  gemini: [
    { value: 'gemini-3-flash-preview',        label: 'Gemini 3 Flash      —  fast' },
    { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite  —  cost-efficient' }
  ]
};

// Popup persists only the connection-level settings (provider, model, keys).
// Profile + fillFormEnabled live exclusively on the full settings page now —
// not read or written here. fillFormEnabled is preserved on save by passing
// through whatever the settings page wrote.
const SYNC_KEYS = ['provider', 'model', 'ollamaBaseUrl', 'claudeApiKey', 'openaiApiKey', 'geminiApiKey', 'fillFormEnabled', 'enabled'];
const apiKeyName = p => `${p}ApiKey`;

const $ = id => document.getElementById(id);

const providerInput  = $('provider');
const apiKeyEl       = $('apiKey');
const toggleKeyBtn   = $('toggleKey');
const ollamaUrlEl    = $('ollamaBaseUrl');
const modelEl        = $('model');
const saveBtn        = $('save');
const historyBtn     = $('openHistory');
const settingsBtn    = $('openSettings');
const statusEl       = $('status');
const statusDot      = $('statusDot');
const apiKeyGroup    = $('apiKeyGroup');
const ollamaGroup    = $('ollamaUrlGroup');
const refreshBtn     = $('refreshModels');
const enabledToggle  = $('enabledToggle');
const tabs           = document.querySelectorAll('.tab');

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ── Provider tabs ──
tabs.forEach(tab => {
  tab.addEventListener('click', async () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const provider = tab.dataset.value;
    providerInput.value = provider;
    const saved = await new Promise(r => chrome.storage.sync.get(SYNC_KEYS, r));
    const savedModel = saved.provider === provider ? saved.model : null;
    apiKeyEl.value = saved[apiKeyName(provider)] || '';
    applyProvider(provider, savedModel);
  });
});

function setActiveTab(value) {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.value === value));
}

function applyProvider(provider, selectedModel) {
  if (provider === 'ollama') {
    hide(apiKeyGroup);
    show(ollamaGroup);
    show(refreshBtn);
    fetchOllamaModels(ollamaUrlEl.value).then(models => {
      if (models && models.length > 0) {
        populateModels(models, selectedModel);
      } else {
        populateModels(
          selectedModel ? [{ value: selectedModel, label: selectedModel }]
                        : [{ value: '', label: 'Click ↺ SYNC to load models' }],
          selectedModel
        );
      }
    });
  } else {
    show(apiKeyGroup);
    hide(ollamaGroup);
    hide(refreshBtn);
    populateModels(STATIC_MODELS[provider] || [], selectedModel);
  }
}

function populateModels(models, selectedValue) {
  modelEl.innerHTML = models
    .map(m => `<option value="${m.value}"${m.value === selectedValue ? ' selected' : ''}>${m.label}</option>`)
    .join('');
}

async function fetchOllamaModels(baseUrl) {
  const url = `${(baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models || []).map(m => ({ value: m.name, label: m.name }));
  } catch { return null; }
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.textContent = '···';
  refreshBtn.disabled = true;
  const models = await fetchOllamaModels(ollamaUrlEl.value);
  refreshBtn.textContent = '↺ SYNC';
  refreshBtn.disabled = false;
  if (models && models.length > 0) {
    populateModels(models);
    flashStatus('MODELS SYNCED', 'success');
  } else {
    flashStatus('CANNOT REACH OLLAMA', 'error');
  }
});

toggleKeyBtn.addEventListener('click', () => {
  const hiding = apiKeyEl.type === 'text';
  apiKeyEl.type = hiding ? 'password' : 'text';
  toggleKeyBtn.setAttribute('aria-label', hiding ? 'Show key' : 'Hide key');
});

saveBtn.addEventListener('click', () => {
  const provider      = providerInput.value;
  const apiKey        = apiKeyEl.value.trim();
  const model         = modelEl.value;
  const ollamaBaseUrl = (ollamaUrlEl.value.trim() || 'http://localhost:11434').replace(/\/$/, '');

  if (provider !== 'ollama' && !apiKey) {
    return flashStatus('API KEY REQUIRED', 'error');
  }
  if (!model) {
    return flashStatus('SELECT A MODEL', 'error');
  }

  // Don't touch fillFormEnabled here — settings page owns it. Same for
  // userProfile in storage.local.
  chrome.storage.sync.set({ provider, [apiKeyName(provider)]: apiKey, model, ollamaBaseUrl }, () => {
    flashStatus('SAVED', 'success');
  });
});

settingsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
});
historyBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
});

// Global on/off — writes immediately, no Save click needed. Content scripts
// pick up the change via chrome.storage.onChanged and tear down any visible
// UI in the same tick.
enabledToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabledToggle.checked });
});

function flashStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type} show`;
  statusDot.className = `hd-dot ${type === 'success' ? 'ok' : 'err'}`;
  clearTimeout(statusEl._t);
  statusEl._t = setTimeout(() => {
    statusEl.classList.remove('show');
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status'; }, 300);
    statusDot.className = 'hd-dot';
  }, 2500);
}

// ── Load saved settings ──
chrome.storage.sync.get(SYNC_KEYS, async data => {
  const provider = data.provider || 'claude';
  providerInput.value = provider;
  apiKeyEl.value      = data[apiKeyName(provider)] || '';
  ollamaUrlEl.value   = data.ollamaBaseUrl || 'http://localhost:11434';
  // Default true: a fresh install has Aide on. Only an explicit `false`
  // unchecks the box.
  enabledToggle.checked = data.enabled !== false;

  setActiveTab(provider);
  applyProvider(provider, data.model);

  if (provider === 'ollama') {
    const models = await fetchOllamaModels(data.ollamaBaseUrl);
    if (models && models.length > 0) {
      populateModels(models, data.model);
    } else {
      populateModels(
        data.model ? [{ value: data.model, label: data.model }]
                   : [{ value: '', label: 'Click SYNC to load models' }],
        data.model
      );
    }
  }
});
