export const SYSTEM = [
  'You are a form-filling assistant. Output ONLY the raw value to insert into the field.',
  'Hard rules:',
  '- No preamble, no explanation, no sign-off, no "Sure", no "Here is".',
  '- Never wrap output in quotes, backticks, or markdown unless the field expects markdown.',
  '- Never repeat the field label, instruction, or placeholder in the output.',
  '- If "Max characters" is given, the output MUST fit within it. Prefer concise over truncated.',
  '- If "Min characters" is given, the output MUST meet it.',
  '- If "Pattern (regex)" is given, the output MUST match it.',
  '- For input type email/url/tel/number/date/time, output a single valid value of that exact format and nothing else.',
  '- For single-line inputs (anything other than textarea/contenteditable), output a single line with no newlines.',
  '- For textarea/contenteditable, newlines are allowed; use them only when the content needs them.'
].join('\n');

// Max tokens by call kind. Define output is a small JSON object (~80 tokens
// in practice) so a tight cap saves cost. Explain wants a 2-3 sentence prose
// budget; followup is mid-length conversational.
export const MAX_TOKENS = { word: 128, explain: 512, followup: 384 };

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
  required: ['pos', 'definition', 'example']
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
// fitting maxChars). Explain/define wants natural prose. Followup slightly
// looser to avoid parroting prior answer verbatim.
export const TEMPERATURE = { form: 0.3, explain: 0.5, followup: 0.6 };

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
      system: 'You are a helpful assistant continuing a conversation about selected text from a web page. Answer the follow-up concisely (2-4 sentences). Use the full transcript for context, not just the most recent turn. Reply in the same language as the latest user question (or the original text when ambiguous). No preamble.',
      user: `Original text: "${context?.originalText || ''}"\n${pageLine}\nTranscript so far:\n${transcript}\nQ: ${text}`
    };
  }
  if (kind === 'word') {
    return {
      system: [
        'You are a concise dictionary.',
        'Output ONLY a single JSON object with EXACTLY these three keys:',
        '{"pos": "<part of speech, e.g. noun / verb / adjective>", "definition": "<1-2 sentence definition>", "example": "<one short example sentence using the word>"}',
        'Hard rules:',
        '- No preamble, no commentary, no trailing text.',
        '- No markdown, no code fences, no backticks.',
        '- Output must parse as JSON. Use double quotes. Escape internal quotes.',
        '- If the input has multiple senses, pick the one that fits the page context best, otherwise the most common one.',
        '- Write the definition and example in the same language as the input word.'
      ].join('\n'),
      user: `Word: "${text}"\n${pageLine}`
    };
  }
  return {
    system: 'You are a helpful explainer. Given selected text, explain it clearly in 2-3 sentences for a general audience. Use the page context (domain + title) to disambiguate jargon (e.g. terms on github.com vs a recipe site). Reply in the same language as the selected text. No preamble.',
    user: `Text: "${text}"\n${pageLine}`
  };
}
