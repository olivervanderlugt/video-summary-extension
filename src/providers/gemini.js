import { errorDetail, statusError } from './errors.js';

export const id = 'gemini';
export const label = 'Google Gemini';
export const defaultModel = 'gemini-2.5-flash';
// Google renames models often; the options UI fills this from the live list.
export const fallbackModels = ['gemini-2.5-flash', 'gemini-2.5-pro'];
export const origin = 'https://generativelanguage.googleapis.com/*';
export const keysUrl = 'https://aistudio.google.com/app/apikey';
export const keyPlaceholder = 'AIza...';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const base = (baseUrl) => (baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');

// A key in the query string ends up in every proxy and server log; use the header.
const authHeaders = (key) => ({ 'x-goog-api-key': key || '' });

export function buildRequest({ key, model, baseUrl, system, messages, maxTokens }) {
  const body = {
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  return {
    // encoded: the model name lands in the URL path, so a stray `../` in it
    // would otherwise reshape the request target.
    url: `${base(baseUrl)}/models/${encodeURIComponent(model || defaultModel)}:streamGenerateContent?alt=sse`,
    headers: { 'content-type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify(body),
  };
}

export function buildModelsRequest({ key, baseUrl }) {
  return { url: `${base(baseUrl)}/models`, headers: authHeaders(key) };
}

export function parseModels(json) {
  return (Array.isArray(json?.models) ? json.models : [])
    .filter((m) => (m?.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
}

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST']);

export function extractDelta(event) {
  const blocked = event?.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(`Gemini refused to summarize this transcript (${blocked}) — try a different provider or model.`);
  }
  const candidate = event?.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && BLOCKED_FINISH.has(finish)) {
    throw new Error(`Gemini stopped part-way through (${finish}) — try a different provider or model.`);
  }
  return (candidate?.content?.parts || []).map((p) => p?.text || '').join('');
}

export function parseError(status, bodyText) {
  const detail = errorDetail(bodyText);
  // Google answers an invalid or missing key with 400 API_KEY_INVALID, not 401.
  // Left generic, the commonest first-run mistake loses its "Open settings" button.
  const badKey =
    /API_KEY_INVALID|API_KEY_MISSING/.test(String(bodyText || '')) ||
    (/api[ _]?key/i.test(detail) && /invalid|not valid|expired|missing/i.test(detail));
  if (status === 400 && badKey) {
    return {
      code: 'auth',
      message: `Google rejected the API key (${detail || 'API_KEY_INVALID'}) — create a fresh key at ${keysUrl} and paste it into the extension options.`,
    };
  }
  return statusError(status, detail, {
    name: 'Google',
    keysUrl,
    statusUrl: 'status.cloud.google.com',
  });
}
