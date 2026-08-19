export const id = 'anthropic';
export const label = 'Anthropic (Claude)';
export const defaultModel = 'claude-opus-5';
export const fallbackModels = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
export const origin = 'https://api.anthropic.com/*';
export const keysUrl = 'https://console.anthropic.com/settings/keys';
export const keyPlaceholder = 'sk-ant-...';
export const docsUrl = 'https://docs.anthropic.com/en/api/messages';

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
  return (json?.data || [])
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
  let detail = '';
  try {
    detail = JSON.parse(bodyText)?.error?.message || '';
  } catch {
    detail = '';
  }
  if (status === 401 || status === 403) {
    return { code: 'auth', message: 'Anthropic rejected your API key — paste a current key from console.anthropic.com into the extension options.' };
  }
  if (status === 429) {
    return { code: 'rate_limit', message: 'Anthropic is rate limiting this key — wait a minute and summarise again, or use a smaller model.' };
  }
  if (status === 400) {
    return { code: 'bad_request', message: `Anthropic rejected the request${detail ? `: ${detail}` : ''} — this video may be too long for the selected model, so try a shorter one or a larger-context model.` };
  }
  if (status === 404) {
    return { code: 'model', message: 'Anthropic does not recognise the selected model — pick a different one in the extension options.' };
  }
  if (status >= 500) {
    return { code: 'server', message: 'Anthropic is having trouble right now — wait a moment and try again.' };
  }
  return { code: 'unknown', message: `Anthropic returned an unexpected error (HTTP ${status})${detail ? `: ${detail}` : ''} — try again, and check status.anthropic.com if it keeps happening.` };
}
