'use strict';

const HISTORY_KEY = 'aideHistory';

const KIND_LABELS = {
  explain:  'EXPLAIN',
  word:     'DEFINE',
  followup: 'FOLLOW-UP',
  generate: 'GENERATE',
  fillForm: 'FILL FORM'
};

const $ = id => document.getElementById(id);

const listEl    = $('list');
const emptyEl   = $('empty');
const searchEl  = $('search');
const clearBtn  = $('clearAll');
const filterBtns = document.querySelectorAll('.filter');

let allEntries = [];
let currentKind = 'all';
let currentQuery = '';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth() &&
    a.getDate()     === b.getDate();
  if (sameDay(d, today)) return 'TODAY';
  if (sameDay(d, y))     return 'YESTERDAY';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function trySnippet(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// fillForm output is a JSON string returned by the model. Try to parse so
// we can render rows; on failure, just show raw text.
function parseFills(raw) {
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj?.fills))  return obj.fills;
    if (Array.isArray(obj?.values)) return obj.values;
    if (Array.isArray(obj))         return obj;
  } catch {}
  return null;
}

function entrySummary(e) {
  if (e.kind === 'fillForm') {
    const fields = e.input?.fields || [];
    return `Filled ${fields.length} field${fields.length === 1 ? '' : 's'}`;
  }
  if (e.kind === 'generate') {
    const label = e.input?.fieldLabel || 'field';
    const prompt = e.input?.prompt;
    return prompt ? `${label} — ${trySnippet(prompt, 60)}` : label;
  }
  // explain / word / followup
  return trySnippet(e.input?.text || '', 90) || '(no input)';
}

function renderRow(label, value, opts = {}) {
  const cls = opts.muted ? 'row-value muted' : 'row-value';
  return `
    <div class="row">
      <div class="row-label">${escapeHtml(label)}</div>
      <div class="${cls}">${opts.html ? value : escapeHtml(value)}</div>
    </div>`;
}

function renderFillFormBody(e) {
  const fills = parseFills(e.output);
  const labelMap = new Map((e.input?.fields || []).map(f => [f.key, f.label]));
  let outputHtml;
  if (fills && fills.length) {
    const rows = fills.map(f => `
      <div class="fill-key">${escapeHtml(labelMap.get(f.key) || f.key)}</div>
      <div class="fill-val">${escapeHtml(f.value || '')}</div>
    `).join('');
    outputHtml = `<div class="fill-list">${rows}</div>`;
  } else {
    outputHtml = escapeHtml(e.output || '');
  }
  const inFields = (e.input?.fields || []).map(f => f.label || f.key).join(' · ') || '—';
  return [
    renderRow('PAGE',     e.pageTitle || e.hostname || '—'),
    renderRow('FIELDS',   inFields),
    renderRow('OUTPUT',   outputHtml, { html: true }),
    renderRow('MODEL',    `${e.provider || '?'} · ${e.model || '?'}`, { muted: true })
  ].join('');
}

function renderGenericBody(e) {
  const label =
    e.kind === 'word'     ? 'WORD' :
    e.kind === 'followup' ? 'QUESTION' :
    e.kind === 'generate' ? 'PROMPT' : 'SELECTION';

  const rows = [];
  rows.push(renderRow('PAGE', e.pageTitle || e.hostname || '—'));

  if (e.kind === 'generate') {
    if (e.input?.fieldLabel) rows.push(renderRow('FIELD', e.input.fieldLabel));
    rows.push(renderRow(label, e.input?.prompt || '(no prompt)'));
  } else {
    rows.push(renderRow(label, e.input?.text || '—'));
  }

  if (e.kind === 'followup' && e.input?.originalText) {
    rows.push(renderRow('ANCHOR', trySnippet(e.input.originalText, 220), { muted: true }));
  }
  if (e.kind === 'word' && e.input?.surrounding) {
    rows.push(renderRow('CONTEXT', trySnippet(e.input.surrounding, 220), { muted: true }));
  }

  rows.push(renderRow('OUTPUT', e.output || ''));
  rows.push(renderRow('MODEL', `${e.provider || '?'} · ${e.model || '?'}`, { muted: true }));
  return rows.join('');
}

function renderEntry(e) {
  const kindLabel = KIND_LABELS[e.kind] || e.kind.toUpperCase();
  const summary   = entrySummary(e);
  const meta      = [fmtTime(e.ts), e.hostname || ''].filter(Boolean).join(' · ');
  const body      = e.kind === 'fillForm' ? renderFillFormBody(e) : renderGenericBody(e);

  return `
    <article class="entry" data-id="${escapeHtml(e.id)}">
      <header class="entry-head">
        <span class="kind-badge kind-${escapeHtml(e.kind)}">${escapeHtml(kindLabel)}</span>
        <span class="entry-summary">${escapeHtml(summary)}</span>
        <span class="entry-meta">${escapeHtml(meta)}</span>
        <span class="caret">▸</span>
      </header>
      <div class="entry-body">
        ${body}
        <button class="copy-btn" data-copy="${escapeHtml(e.output || '')}">⧉ COPY OUTPUT</button>
      </div>
    </article>`;
}

function applyFilters(entries) {
  const q = currentQuery.toLowerCase();
  return entries.filter(e => {
    if (currentKind !== 'all' && e.kind !== currentKind) return false;
    if (!q) return true;
    const hay = [
      e.input?.text, e.input?.prompt, e.input?.fieldLabel, e.input?.originalText,
      e.output, e.pageTitle, e.hostname
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function render() {
  const filtered = applyFilters(allEntries);
  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = allEntries.length
      ? 'No entries match your filter.'
      : 'No entries yet. Use Aide on a page — explain text, generate field values, or fill a form.';
    return;
  }
  emptyEl.classList.add('hidden');

  // Newest first; group by day header.
  const sorted = filtered.slice().sort((a, b) => b.ts - a.ts);
  let html = '';
  let lastDay = null;
  for (const e of sorted) {
    const day = fmtDay(e.ts);
    if (day !== lastDay) {
      html += `<div class="day">${escapeHtml(day)}</div>`;
      lastDay = day;
    }
    html += renderEntry(e);
  }
  listEl.innerHTML = html;
}

// ── Wiring ──

listEl.addEventListener('click', async (e) => {
  const copy = e.target.closest('.copy-btn');
  if (copy) {
    e.stopPropagation();
    const text = copy.getAttribute('data-copy') || '';
    try {
      await navigator.clipboard.writeText(text);
      const prev = copy.textContent;
      copy.textContent = '✓ COPIED';
      setTimeout(() => { copy.textContent = prev; }, 1200);
    } catch {}
    return;
  }
  const head = e.target.closest('.entry-head');
  if (head) head.parentElement.classList.toggle('open');
});

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentKind = btn.dataset.kind;
    render();
  });
});

let searchT = null;
searchEl.addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    currentQuery = searchEl.value.trim();
    render();
  }, 120);
});

clearBtn.addEventListener('click', async () => {
  if (!allEntries.length) return;
  if (!confirm(`Delete all ${allEntries.length} history entries? This can't be undone.`)) return;
  await chrome.storage.local.remove([HISTORY_KEY]);
  allEntries = [];
  render();
});

// Live-update if a new interaction lands while the page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[HISTORY_KEY]) return;
  allEntries = Array.isArray(changes[HISTORY_KEY].newValue) ? changes[HISTORY_KEY].newValue : [];
  render();
});

// ── Bootstrap ──
chrome.storage.local.get([HISTORY_KEY], data => {
  allEntries = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  render();
});
