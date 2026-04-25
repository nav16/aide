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

export const MAX_TOKENS = { form: 256, explain: 512 };

// Temperature by call type. Form-fill wants determinism (valid formats,
// fitting maxChars). Explain/define wants natural prose. Followup slightly
// looser to avoid parroting prior answer verbatim.
export const TEMPERATURE = { form: 0.3, explain: 0.5, followup: 0.6 };

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
  lines.push(userPrompt ? `Instruction: ${userPrompt}` : 'Generate appropriate content for this field.');
  return lines.join('\n');
}

export function explainPrompts(kind, text, pageTitle, context) {
  if (kind === 'followup') {
    return {
      system: 'You are a helpful assistant continuing a conversation about selected text from a web page. Answer the follow-up concisely (2-4 sentences). No preamble.',
      user: `Original text: "${context?.originalText || ''}"\nPrior answer: "${context?.prior || ''}"\nFollow-up: ${text}\nPage context: "${pageTitle}"`
    };
  }
  return {
    system: kind === 'word'
      ? 'You are a concise dictionary. Given a word, respond with: part of speech, definition (1-2 sentences), and a short example sentence. No preamble.'
      : 'You are a helpful explainer. Given selected text, explain it clearly in 2-3 sentences for a general audience. No preamble.',
    user: kind === 'word'
      ? `Word: "${text}"\nPage context: "${pageTitle}"`
      : `Text: "${text}"\nPage context: "${pageTitle}"`
  };
}
