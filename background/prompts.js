// Kept short on purpose: every line is system-prompt input billed on cold
// requests until Anthropic prompt cache warms. Five dense lines beat a
// thirteen-line bullet list with no quality loss in observed runs.
export const SYSTEM = [
  'Output ONLY the raw field value: no preamble, quotes, backticks, markdown, label echo, or sign-off.',
  'Honor maxChars (be concise, never truncate mid-word), minChars, and any pattern regex exactly.',
  'For email/url/tel/number/date/time inputs, emit a single valid value of that exact format and nothing else.',
  'Single-line inputs: no newlines. Textarea/contenteditable: newlines only when the content needs them.',
  'If a User profile block is given, use its values verbatim for matching fields (name, email, phone, address). Never invent profile data.'
].join('\n');

// Hard ceilings by call kind. Define output is a small JSON object (~80
// tokens in practice). The cap is loose enough that any rogue preamble from
// Gemini before the JSON does not truncate the JSON itself.
export const MAX_TOKENS = { word: 256, explain: 512, followup: 384 };

// Per-call token cap that scales with the input length. A 4-word selection
// asks for a tiny explanation; a 1k-char passage may want the full ceiling.
// Letting the provider know the real budget lets it plan generation and,
// crucially, lets it terminate sooner once it has enough — meaningful
// latency win on short selections.
export function tokensForExplain(kind, text) {
  const len = (text || '').length;
  const ceil = MAX_TOKENS[kind] || MAX_TOKENS.explain;
  // Floor covers structured-output overhead (JSON braces, fence preambles
  // some providers emit before the body) so we never starve the response.
  const floor = kind === 'followup' ? 128 : 96;
  return Math.min(ceil, floor + Math.ceil(len / 3));
}

// Schema for define output. Used by providers that support native structured
// outputs to lock the response shape — kills cross-model variance and removes
// JSON-parse failures on smaller models.
export const DEFINE_SCHEMA = {
  type: 'object',
  properties: {
    pos:        { type: 'string', description: 'Part of speech: noun, verb, adjective, etc.' },
    definition: { type: 'string', description: '1-2 sentence definition of the word.' },
    example:    { type: 'string', description: 'One short example sentence using the word.' }
  },
  required: ['pos', 'definition', 'example'],
  // OpenAI strict json_schema requires additionalProperties:false. Gemini's
  // sanitizer strips this key (its OpenAPI subset rejects it). Claude tool-use
  // and Ollama format-as-schema accept it.
  additionalProperties: false
};

// Pick a token cap matched to the field. Short typed inputs (email/url/tel)
// rarely need more than ~16 tokens; long-form fields want headroom. When
// maxChars is known, cap by ~chars/3 (rough chars-per-token) plus slack.
export function tokensForField(ctx) {
  const t = ctx?.inputType || 'text';
  const longForm = t === 'textarea' || t === 'contenteditable';
  let cap;
  if (t === 'number')                                      cap = 16;
  else if (t === 'email' || t === 'url' || t === 'tel')    cap = 32;
  else if (t === 'date'  || t === 'time' || t === 'month' ||
           t === 'week'  || t === 'datetime-local')        cap = 16;
  else if (longForm)                                       cap = 1024;
  else                                                     cap = 96;

  if (ctx?.maxChars) {
    const fromChars = Math.ceil(ctx.maxChars / 3) + 8;
    cap = Math.min(cap, fromChars);
  }
  return Math.max(cap, 8);
}

// Temperature by call type. Form-fill wants determinism (valid formats,
// fitting maxChars). Define is dictionary-precision — low temp keeps the
// part-of-speech and sense stable across calls. Explain wants natural prose.
// Followup slightly looser to avoid parroting prior answer verbatim.
export const TEMPERATURE = { form: 0.3, word: 0.2, explain: 0.5, followup: 0.6 };

// Stop tokens for fields that should never contain newlines. textarea and
// contenteditable allow multi-line, so no stop there. Helps when the model
// adds a trailing explanation line after the value.
export function stopForField(ctx) {
  const t = ctx?.inputType || 'text';
  if (t === 'textarea' || t === 'contenteditable') return null;
  return ['\n'];
}

// Models still occasionally leak preambles ("Sure,", "Here is...") or wrap
// the value in quotes/backticks despite the system rules. Strip those before
// inserting into the field. Only applied to form-fill, not explain/define.
const PREAMBLE_RE = /^(?:sure[,!.\s]+|certainly[,!.\s]+|of course[,!.\s]+|here(?:'s| is| you go)[:,.\s-]+|okay[,!.\s]+|answer[:\s]+|response[:\s]+|output[:\s]+|value[:\s]+)/i;

// Server-side cleanup for define output. Strip ```json fences and common
// preambles before returning to the frontend so the popup parser sees pure
// JSON regardless of which provider/model emitted it. Frontend extractJson
// is still the last line of defense.
export function cleanDefineOutput(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  // Strip ```json ... ``` or ``` ... ``` (open + close form).
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  // Strip an unclosed opening fence (truncated response).
  s = s.replace(/^```(?:json)?\s*/i, '');
  // Strip leading prose preambles up to the first '{'.
  const brace = s.indexOf('{');
  if (brace > 0) s = s.slice(brace);
  // Trim trailing prose after the last balanced '}'.
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);
  return s.trim();
}

// Same cleanup shape as cleanDefineOutput but for fillForm. Ollama's
// format-as-schema is a soft constraint on some local models — they still
// emit ```json fences or a prose lead-in. Slice out the first balanced JSON
// object so JSON.parse on the frontend doesn't throw.
export function cleanFillFormOutput(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  s = s.replace(/^```(?:json)?\s*/i, '');
  const brace = s.indexOf('{');
  if (brace !== -1) {
    if (brace > 0) s = s.slice(brace);
    // Walk to the matching close so trailing prose is cut without breaking
    // strings that contain literal '}' characters.
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"')  { inStr = false; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{')  depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end !== -1) return s.slice(0, end).trim();
  }
  // Fallback: smaller Ollama models ignore format=schema and emit a YAML/dash
  // list ("- f0: value"). Convert to the canonical JSON shape so the frontend
  // parser doesn't have to know about provider-specific quirks. Matches both
  // bare and quoted values; strips common quote wraps.
  const lineRe = /^\s*[-*]?\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
  const fills = [];
  for (const line of s.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    let value = m[2].trim();
    // Drop matched wrapping quotes/backticks so `"foo"` becomes foo.
    const wraps = [['"','"'], ["'","'"], ['`','`']];
    for (const [o, c] of wraps) {
      if (value.length >= 2 && value.startsWith(o) && value.endsWith(c)) {
        value = value.slice(1, -1);
        break;
      }
    }
    fills.push({ key: m[1], value });
  }
  if (fills.length) return JSON.stringify({ fills });
  return s.trim();
}

export function cleanFormOutput(raw, ctx) {
  if (!raw) return raw;
  let s = raw.trim();

  // Strip up to two preamble layers ("Sure! Here is: ...").
  for (let i = 0; i < 2; i++) {
    const next = s.replace(PREAMBLE_RE, '').trim();
    if (next === s) break;
    s = next;
  }

  // Drop wrapping quotes/backticks if they wrap the entire output.
  const wraps = [['"','"'], ["'","'"], ['`','`'], ['“','”'], ['‘','’']];
  for (const [open, close] of wraps) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, -close.length).trim();
      break;
    }
  }

  // Fenced code block wrap: ```lang\n...\n``` → keep inner only.
  const fence = s.match(/^```[\w-]*\n?([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();

  // For single-line fields, collapse any stray newlines defensively (the stop
  // sequence usually catches this, but local models sometimes ignore it).
  const t = ctx?.inputType || 'text';
  if (t !== 'textarea' && t !== 'contenteditable') {
    s = s.split('\n')[0].trim();
  }

  // Clip to maxChars rather than hand the field a value the browser will
  // silently truncate (which can break submit validation).
  if (ctx?.maxChars && s.length > ctx.maxChars) {
    s = s.slice(0, ctx.maxChars);
  }
  return s;
}

// One-shot multi-field fill. Schema returns one {key,value} per descriptor —
// model fills the entire form in a single call so values stay internally
// consistent (first-name + last-name + full-name + email all describe the same
// person). Empty value = skip. Frontend pre-builds a key->element map so we
// can route values back to elements without serializing DOM refs.
export const FILL_FORM_SCHEMA = {
  type: 'object',
  properties: {
    fills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key:   { type: 'string', description: 'The "key" from the field descriptor.' },
          value: { type: 'string', description: 'Value to insert. Empty string when no good value.' }
        },
        required: ['key', 'value'],
        additionalProperties: false
      }
    }
  },
  required: ['fills'],
  additionalProperties: false
};

// Same trim rationale as SYSTEM. JSON-shape rules are dense-packed; the lone
// example carries more weight than another bullet of prose.
const FILL_FORM_SYSTEM = [
  'Fill MULTIPLE form fields in one call. Return ONLY a JSON object — no prose, no fences, no comments. First char `{`, last char `}`. Shape: {"fills":[{"key":"<key>","value":"<value or \\"\\">"}, ...]}.',
  'Return one entry per provided key — never add or omit keys. Each value must satisfy the field\'s type, pattern, maxChars, and minChars.',
  'Keep values consistent across the form (first/last/full name, email, phone, address all describe the same person).',
  'If a field maps to the User profile, use its value verbatim. Never invent profile data — for non-required fields without a profile match return ""; for required fields without a match emit a plausible value of the right shape.',
  'For email/url/tel/number/date/time emit a single valid value of exactly that format. Single-line fields: no newlines. Concise beats truncated.',
  'Example: {"fills":[{"key":"f0","value":"Jane Doe"},{"key":"f1","value":"jane@example.com"}]}'
].join('\n');

export function fillFormPrompts(fields, pageTitle, hostname) {
  const pageLine = hostname ? `Page: "${pageTitle}" (${hostname})` : `Page: "${pageTitle}"`;
  const lines = [pageLine];
  const formCtx = fields.find(f => f.formContext)?.formContext;
  if (formCtx) lines.push(`Form: "${formCtx}"`);
  lines.push('Fields:');
  const q = s => String(s).replace(/"/g, '\\"').slice(0, 160);
  for (const f of fields) {
    const parts = [`key=${f.key}`, `label="${q(f.label || '')}"`];
    if (f.inputType && f.inputType !== 'text') parts.push(`type=${f.inputType}`);
    if (f.placeholder)  parts.push(`placeholder="${q(f.placeholder)}"`);
    if (f.autocomplete) parts.push(`autocomplete=${f.autocomplete}`);
    if (f.pattern)      parts.push(`pattern=${q(f.pattern)}`);
    if (f.required)     parts.push('required=yes');
    if (f.maxChars)     parts.push(`maxChars=${f.maxChars}`);
    if (f.minChars)     parts.push(`minChars=${f.minChars}`);
    if (f.describedBy)  parts.push(`help="${q(f.describedBy)}"`);
    if (f.currentValue) parts.push(`currentValue="${q(f.currentValue.slice(0, 80))}"`);
    lines.push('- ' + parts.join(' | '));
  }
  lines.push('Generate values for ALL field keys above. One entry per key.');
  return { system: FILL_FORM_SYSTEM, user: lines.join('\n') };
}

export function userMsg(ctx, userPrompt, pageTitle) {
  ctx = ctx || {};
  const lines = [];
  const pageLine = ctx.hostname ? `Page: "${pageTitle}" (${ctx.hostname})` : `Page: "${pageTitle}"`;
  lines.push(pageLine);
  if (ctx.formContext)  lines.push(`Form: "${ctx.formContext}"`);
  lines.push(`Field: "${ctx.label || 'this field'}"`);
  if (ctx.placeholder)  lines.push(`Placeholder: "${ctx.placeholder}"`);
  if (ctx.inputType && ctx.inputType !== 'text') lines.push(`Input type: ${ctx.inputType}`);
  if (ctx.autocomplete) lines.push(`Autocomplete: ${ctx.autocomplete}`);
  if (ctx.pattern)      lines.push(`Pattern (regex): ${ctx.pattern}`);
  if (ctx.describedBy)  lines.push(`Help text: "${ctx.describedBy}"`);
  if (ctx.required)     lines.push('Required: yes');
  if (ctx.maxChars)     lines.push(`Max characters: ${ctx.maxChars}`);
  if (ctx.minChars)     lines.push(`Min characters: ${ctx.minChars}`);
  if (ctx.min != null)  lines.push(`Min value: ${ctx.min}`);
  if (ctx.max != null)  lines.push(`Max value: ${ctx.max}`);
  if (ctx.step != null) lines.push(`Step: ${ctx.step}`);
  if (ctx.currentValue) {
    // Show the draft on its own block so the model treats it as material to
    // continue/refine, not as part of the instruction.
    lines.push('Current draft (continue or refine; do not duplicate):');
    lines.push(ctx.currentValue);
  }
  lines.push(userPrompt ? `Instruction: ${userPrompt}` : 'Generate appropriate content for this field.');
  return lines.join('\n');
}

export function explainPrompts(kind, text, pageTitle, context, hostname) {
  const pageLine = hostname
    ? `Page context: "${pageTitle}" (${hostname})`
    : `Page context: "${pageTitle}"`;

  if (kind === 'followup') {
    const turns = Array.isArray(context?.turns) ? context.turns : [];
    const transcript = turns.length
      ? turns.map(t => `${t.role === 'user' ? 'Q' : 'A'}: ${t.content}`).join('\n')
      // Backwards-compat: older callers only sent prior + originalText.
      : `A: ${context?.prior || ''}`;
    return {
      system: [
        'You are a helpful assistant continuing a conversation about selected text from a web page.',
        'Match answer length to question complexity:',
        '- Yes/no or single-fact questions: one sentence.',
        '- Brief clarifications: 1-2 sentences.',
        '- Conceptual or "explain why/how" questions: up to 4 sentences.',
        '- Never pad to fill space.',
        'Use the full transcript for context, not just the most recent turn.',
        'Reply in the same language as the latest user question (or the original text when ambiguous).',
        'No preamble.'
      ].join('\n'),
      user: `Original text: "${context?.originalText || ''}"\n${pageLine}\nTranscript so far:\n${transcript}\nQ: ${text}`
    };
  }
  if (kind === 'word') {
    const surrounding = (context?.surrounding || '').trim();
    return {
      system: [
        'You are a concise dictionary.',
        'Output ONLY a single JSON object with EXACTLY these three keys:',
        '{"pos": "<part of speech, e.g. noun / verb / adjective>", "definition": "<1-2 sentence definition>", "example": "<one short example sentence using the word>"}',
        'Hard rules:',
        '- The VERY FIRST character of your response MUST be `{`. Do not write "Here", "Here is", "Sure", or any other text before it.',
        '- The VERY LAST character of your response MUST be `}`. No trailing commentary.',
        '- No markdown, no code fences, no backticks.',
        '- Output must parse as JSON. Use double quotes. Escape internal quotes.',
        '- If the input has multiple senses, use the surrounding text (when provided) to pick the sense that fits. Fall back to page context (domain + title), then to the most common sense.',
        '- The example sentence must illustrate the chosen sense. Do not echo the surrounding text.',
        '- Write the definition and example in the same language as the input word.'
      ].join('\n'),
      user: surrounding
        ? `Word: "${text}"\n${pageLine}\nSurrounding text: "${surrounding}"`
        : `Word: "${text}"\n${pageLine}`
    };
  }
  return {
    system: 'You are a helpful explainer. Given selected text, explain it clearly in 2-3 sentences for a general audience. Use the page context (domain + title) to disambiguate jargon (e.g. terms on github.com vs a recipe site). Reply in the same language as the selected text. No preamble.',
    user: `Text: "${text}"\n${pageLine}`
  };
}
