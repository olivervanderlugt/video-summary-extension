import { errorDetail, statusError } from './errors.js';

export const id = 'anthropic';
export const label = 'Anthropic (Claude)';
export const defaultModel = 'claude-opus-5';
export const fallbackModels = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
export const origin = 'https://api.anthropic.com/*';
export const keysUrl = 'https://console.anthropic.com/settings/keys';
export const keyPlaceholder = 'sk-ant-...';

const DEFAULT_BASE = 'https://api.anthropic.com';

const base = (baseUrl) => (baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');

const authHeaders = (key) => ({
  'x-api-key': key || '',
  'anthropic-version': '2023-06-01',
  // Without this header Anthropic refuses any request with a browser Origin.
  'anthropic-dangerous-direct-browser-access': 'true',
});

export function buildRequest({ key, model, baseUrl, system, messages, maxTokens }) {
  const body = {
    model: model || defaultModel,
    max_tokens: maxTokens,
    stream: true,
    messages,
  };
  if (system) body.system = system;
  return {
    url: `${base(baseUrl)}/v1/messages`,
    headers: { 'content-type': 'application/json', ...authHeaders(key) },
    body: JSON.stringify(body),
  };
}

export function buildModelsRequest({ key, baseUrl }) {
  return { url: `${base(baseUrl)}/v1/models`, headers: authHeaders(key) };
}

export function parseModels(json) {
  return (Array.isArray(json?.data) ? json.data : [])
    .map((m) => m?.id)
    .filter((x) => typeof x === 'string' && x)
    .sort();
}

export function extractDelta(event) {
  if (event?.type === 'error') {
    throw new Error(event.error?.message || 'The provider reported an error mid-response.');
  }
  if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return event.delta.text || '';
  }
  return '';
}

export function parseError(status, bodyText) {
  return statusError(status, errorDetail(bodyText), {
    name: 'Anthropic',
    keysUrl,
    statusUrl: 'status.anthropic.com',
  });
}
