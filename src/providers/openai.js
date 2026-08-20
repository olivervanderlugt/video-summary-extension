// Also backs the `compatible` provider (OpenRouter / Groq / LM Studio / Ollama /
// corporate proxies), which is why every URL is derived from baseUrl.
import { errorDetail, statusError } from './errors.js';

export const id = 'openai';
export const label = 'OpenAI';
export const defaultModel = 'gpt-5';
export const fallbackModels = ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o-mini'];
export const origin = 'https://api.openai.com/*';
export const keysUrl = 'https://platform.openai.com/api-keys';
export const keyPlaceholder = 'sk-...';

const DEFAULT_BASE = 'https://api.openai.com/v1';

/**
 * Trailing slashes stripped, and a pasted .../chat/completions treated as the endpoint.
 *
 * `requiresBaseUrl` comes from the adapter (the `compatible` provider sets it).
 * Falling back to api.openai.com there would send the user's key and the whole
 * transcript to a vendor they never chose, and api.openai.com is a permanent
 * host permission so nothing else would stop it. Fail closed instead.
 */
function normalise(baseUrl, requiresBaseUrl) {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed && requiresBaseUrl) {
    throw new Error(
      'No Base URL is set for this provider. Open the extension settings and enter the Base URL of your OpenAI-compatible server — nothing is sent until you do.'
    );
  }
  const raw = trimmed || DEFAULT_BASE;
  const chat = /\/chat\/completions$/.test(raw) ? raw : `${raw}/chat/completions`;
  return { root: chat.replace(/\/chat\/completions$/, ''), chat };
}

const authHeaders = (key) => (key ? { authorization: `Bearer ${key}` } : {});

export function buildRequest({ key, model, baseUrl, requiresBaseUrl, system, messages, maxTokens }) {
  return {
    url: normalise(baseUrl, requiresBaseUrl).chat,
    headers: { 'content-type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify({
      model: model || defaultModel,
      stream: true,
      messages: system ? [{ role: 'system', content: system }, ...messages] : [...messages],
      max_completion_tokens: maxTokens,
    }),
  };
}

export function buildModelsRequest({ key, baseUrl, requiresBaseUrl }) {
  return { url: `${normalise(baseUrl, requiresBaseUrl).root}/models`, headers: authHeaders(key) };
}

// Chat endpoints choke on these; the model list mixes them in with the text models.
const NON_TEXT = /(whisper|tts|dall-e|embedding|moderation|audio|image|realtime|transcribe|search|similarity|edit|davinci|babbage|ada|curie)/i;

export function parseModels(json) {
  return (Array.isArray(json?.data) ? json.data : [])
    .map((m) => m?.id)
    .filter((x) => typeof x === 'string' && x && !NON_TEXT.test(x))
    .sort();
}

export function extractDelta(event) {
  // A mid-stream error arrives as a normal event. Returning '' for it would end
  // the stream cleanly and cache half a summary as if it were the whole thing.
  if (event?.error) {
    const message = typeof event.error === 'string' ? event.error : event.error.message;
    throw new Error(message || 'The provider reported an error mid-response.');
  }
  return event?.choices?.[0]?.delta?.content || '';
}

export function parseError(status, bodyText) {
  // Neutral name on purpose: this adapter also backs OpenRouter and whatever
  // OpenAI-compatible server the user pointed `compatible` at.
  return statusError(status, errorDetail(bodyText), {
    name: 'The provider',
    keysUrl: null,
    statusUrl: "the provider's status page",
  });
}
