'use strict';

const STATIC_MODELS = {
  claude: [
    { value: 'claude-sonnet-4-6',          label: 'Sonnet 4.6  —  recommended' },
    { value: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5   —  fast' },
    { value: 'claude-opus-4-7',            label: 'Opus 4.7    —  powerful' }
  ],
  openai: [
    { value: 'gpt-4o',       label: 'GPT-4o        —  recommended' },
    { value: 'gpt-4o-mini',  label: 'GPT-4o Mini   —  fast' },
    { value: 'gpt-4-turbo',  label: 'GPT-4 Turbo   —  legacy' }
  ],
  gemini: [
    { value: 'gemini-3-flash-preview',          label: 'Gemini 3 Flash         —  fast' },
    { value: 'gemini-3.1-flash-lite-preview',   label: 'Gemini 3.1 Flash Lite  —  cost-efficient' }
  ]
};

const ALL_KEYS = ['provider', 'model', 'ollamaBaseUrl', 'claudeApiKey', 'openaiApiKey', 'geminiApiKey', 'fillFormEnabled'];
const apiKeyName = p => `${p}ApiKey`;

const $ = id => document.getElementById(id);

const providerInput  = $('provider');
const apiKeyEl       = $('apiKey');
const toggleKeyBtn   = $('toggleKey');
const ollamaUrlEl    = $('ollamaBaseUrl');
const userProfileEl  = $('userProfile');
const fillFormToggle = $('fillFormEnabled');
const modelEl        = $('model');
const saveBtn        = $('save');
const statusEl       = $('status');
const apiKeyCard     = $('apiKeyCard');
const ollamaCard     = $('ollamaUrlCard');
const refreshBtn     = $('refreshModels');
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
    const saved = await new Promise(r => chrome.storage.sync.get(ALL_KEYS, r));
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
    hide(apiKeyCard);
    show(ollamaCard);
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
    show(apiKeyCard);
    hide(ollamaCard);
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

  // Profile lives in storage.local — freeform PII (name/email/address) should
  // never ride the sync channel to other devices.
  const userProfile     = userProfileEl.value;
  const fillFormEnabled = fillFormToggle.checked;

  chrome.storage.sync.set({ provider, [apiKeyName(provider)]: apiKey, model, ollamaBaseUrl, fillFormEnabled }, () => {
    chrome.storage.local.set({ userProfile }, () => {
      flashStatus('SETTINGS SAVED', 'success');
    });
  });
});

function flashStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type} show`;
  clearTimeout(statusEl._t);
  statusEl._t = setTimeout(() => {
    statusEl.classList.remove('show');
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status'; }, 300);
  }, 2500);
}

// ── Bootstrap ──
chrome.storage.local.get(['userProfile'], local => {
  userProfileEl.value = local.userProfile || '';
});

chrome.storage.sync.get(ALL_KEYS, async data => {
  const provider = data.provider || 'claude';
  providerInput.value     = provider;
  apiKeyEl.value          = data[apiKeyName(provider)] || '';
  ollamaUrlEl.value       = data.ollamaBaseUrl || 'http://localhost:11434';
  fillFormToggle.checked  = !!data.fillFormEnabled;

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
