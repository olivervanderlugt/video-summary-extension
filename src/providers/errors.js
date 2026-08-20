// The HTTP status ladder every provider answered with its own near-identical
// copy. Provider-specific cases (Gemini's 400-means-bad-key) stay in the
// adapter and are handled before this is called.

/** Every provider wraps its message the same way; an unreadable body is normal. */
export function errorDetail(bodyText) {
  try {
    return JSON.parse(bodyText)?.error?.message || '';
  } catch {
    return '';
  }
}

/**
 * @param {number} status
 * @param {string} detail  already extracted with errorDetail()
 * @param {{name:string, keysUrl?:string|null, statusUrl?:string|null}} provider
 *   `name` is what the user is told rejected them — the openai adapter also
 *   backs OpenRouter and arbitrary local servers, so it passes a neutral one.
 */
export function statusError(status, detail, { name, keysUrl, statusUrl }) {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return {
      code: 'auth',
      message: keysUrl
        ? `${name} rejected your API key — paste a current key from ${keysUrl} into the extension options.`
        : `${name} rejected the API key — check it in the extension options, and make sure it belongs to the base URL you configured.`,
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limit',
      message: `${name} is rate limiting this key (or it is out of credit) — wait a minute and try again, or check your billing page.`,
    };
  }
  if (status === 400) {
    return {
      code: 'bad_request',
      message: `${name} rejected the request${suffix} — this video may be too long for the selected model, so try a shorter one or a larger-context model.`,
    };
  }
  if (status === 404) {
    return {
      code: 'model',
      message: `${name} does not recognize that model or endpoint — check the model name and base URL in the extension options.`,
    };
  }
  if (status >= 500) {
    return {
      code: 'server',
      message: `${name} is having trouble right now — wait a moment and try again.`,
    };
  }
  return {
    code: 'unknown',
    message: `${name} returned an unexpected error (HTTP ${status})${suffix} — try again${statusUrl ? `, and check ${statusUrl} if it keeps happening` : ''}.`,
  };
}

/**
 * A provider failure that already knows its code. The worker's error funnel and
 * its retry both key off `code`; a bare Error lands on `unknown`, which is
 * neither retryable nor something the panel has copy for.
 */
export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

// Mid-stream errors arrive after the HTTP 200, in whatever shape the provider
// likes: OpenRouter puts an HTTP status in `code`, OpenAI a string type
// ("rate_limit_exceeded", "insufficient_quota"), Anthropic a type
// ("overloaded_error"). Matched in order — "invalid_api_key" is auth, not 400.
const MID_STREAM = [
  [/rate.?limit|quota|resource.?exhausted|too.?many.?requests|insufficient|credit/, 429],
  [/overload|unavailable|internal|server.?error|timeout/, 503],
  [/auth|api.?key|credential|permission|forbidden|unauthor/, 401],
  [/not.?found|unknown.?model|no.?such.?model/, 404],
  [/invalid|bad.?request|too.?long|context.?length/, 400],
];

/**
 * The same ladder, for an error the provider reported inside a 200 stream.
 * OpenAI and OpenRouter report rate limits this way, so mapping it back onto a
 * status is what makes a mid-stream 429 read — and retry — like an HTTP one.
 *
 * @param {any} error  the provider's own error object (or a bare string)
 * @param {{name:string, keysUrl?:string|null, statusUrl?:string|null}} provider
 */
export function streamError(error, provider) {
  const raw = error && typeof error === 'object' ? error : { message: String(error || '') };
  const detail = String(raw.message || '');
  const explicit = Number(raw.status ?? raw.code);
  const tag = `${raw.code ?? ''} ${raw.type ?? ''} ${detail}`.toLowerCase();
  const status =
    explicit >= 400 && explicit <= 599 ? explicit : (MID_STREAM.find(([re]) => re.test(tag)) || [])[1];
  if (!status) {
    return new ProviderError('unknown', detail || 'The provider reported an error mid-response.');
  }
  const { code, message } = statusError(status, detail, provider);
  return new ProviderError(code, message);
}
