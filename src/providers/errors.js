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
