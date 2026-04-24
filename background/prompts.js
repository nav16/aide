export const SYSTEM = 'You are a form-filling assistant. Output ONLY the value to insert into the field — no explanation, no preamble, no quotes, no markdown unless formatting is expected.';

export const MAX_TOKENS = { form: 256, explain: 512 };

export function userMsg(label, userPrompt, pageTitle, constraints) {
  let msg = `Page: "${pageTitle}"\nField: "${label}"\n`;
  if (constraints?.maxChars) msg += `Max characters: ${constraints.maxChars}\n`;
  if (constraints?.minChars) msg += `Min characters: ${constraints.minChars}\n`;
  msg += userPrompt ? `Instruction: ${userPrompt}` : 'Generate appropriate content for this field.';
  return msg;
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
