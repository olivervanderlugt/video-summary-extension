// Also backs the `compatible` provider (OpenRouter / Groq / LM Studio / Ollama /
// corporate proxies), which is why every URL is derived from baseUrl.
export const id = 'openai';
export const label = 'OpenAI';
export const defaultModel = 'gpt-5';
export const fallbackModels = ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o-mini'];
export const origin = 'https://api.openai.com/*';
export const keysUrl = 'https://platform.openai.com/api-keys';
export const keyPlaceholder = 'sk-...';

const DEFAULT_BASE = 'https://api.openai.com/v1';

/** Trailing slashes stripped, and a pasted .../chat/completions treated as the endpoint. */
function normalise(baseUrl) {
  const raw = (baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '') || DEFAULT_BASE;
  const chat = /\/chat\/completions$/.test(raw) ? raw : `${raw}/chat/completions`;
  return { root: chat.replace(/\/chat\/completions$/, ''), chat };
}

const authHeaders = (key) => (key ? { authorization: `Bearer ${key}` } : {});

export function buildRequest({ key, model, baseUrl, system, messages, maxTokens }) {
  return {
    url: normalise(baseUrl).chat,
    headers: { 'content-type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify({
      model: model || defaultModel,
      stream: true,
      messages: system ? [{ role: 'system', content: system }, ...messages] : [...messages],
      max_completion_tokens: maxTokens,
    }),
  };
}

export function buildModelsRequest({ key, baseUrl }) {
  return { url: `${normalise(baseUrl).root}/models`, headers: authHeaders(key) };
}

// Chat endpoints choke on these; the model list mixes them in with the text models.
const NON_TEXT = /(whisper|tts|dall-e|embedding|moderation|audio|image|realtime|transcribe|search|similarity|edit|davinci|babbage|ada|curie)/i;

export function parseModels(json) {
  return (json?.data || [])
    .map((m) => m?.id)
    .filter((x) => typeof x === 'string' && x && !NON_TEXT.test(x))
    .sort();
}

export function extractDelta(event) {
  return event?.choices?.[0]?.delta?.content || '';
}

export function parseError(status, bodyText) {
  let detail = '';
  try {
    detail = JSON.parse(bodyText)?.error?.message || '';
  } catch {
    detail = '';
  }
  if (status === 401 || status === 403) {
    return { code: 'auth', message: 'The API key was rejected — check it in the extension options, and make sure it belongs to the base URL you configured.' };
  }
  if (status === 429) {
    return { code: 'rate_limit', message: 'You are being rate limited (or out of credit) — wait a minute and try again, or check your billing page.' };
  }
  if (status === 400) {
    return { code: 'bad_request', message: `The request was rejected${detail ? `: ${detail}` : ''} — this video may be too long for the selected model, so try a shorter one or a larger-context model.` };
  }
  if (status === 404) {
    return { code: 'model', message: 'That model or endpoint was not found — check the model name and base URL in the extension options.' };
  }
  if (status >= 500) {
    return { code: 'server', message: 'The provider is having trouble right now — wait a moment and try again.' };
  }
  return { code: 'unknown', message: `The provider returned an unexpected error (HTTP ${status})${detail ? `: ${detail}` : ''} — try again, and check the provider's status page if it keeps happening.` };
}
