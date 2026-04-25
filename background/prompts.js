export const SYSTEM = 'You are a form-filling assistant. Output ONLY the value to insert into the field — no explanation, no preamble, no quotes, no markdown unless formatting is expected.';

export const MAX_TOKENS = { form: 256, explain: 512 };

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
