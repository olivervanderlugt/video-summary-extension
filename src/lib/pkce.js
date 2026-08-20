/**
 * PKCE (RFC 7636) for the OpenRouter sign-in flow.
 *
 * PKCE exists so a public client — one that cannot keep a secret, which is
 * exactly what an extension is — can still do OAuth safely. The extension picks
 * a random `verifier`, sends only its SHA-256 hash to the provider, and reveals
 * the verifier when redeeming the code. An authorization code intercepted on
 * the way back is useless without it.
 *
 * No DOM and no chrome APIs, so this runs under `node --test` as well as in the
 * service worker.
 */

const VERIFIER_BYTES = 64; // 86 base64url chars — inside RFC 7636's 43..128

/** base64url, unpadded, per RFC 7636 §4.2. Plain base64 is NOT interchangeable. */
export function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createVerifier(crypto = globalThis.crypto) {
  return base64url(crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)));
}

export async function challengeFor(verifier, crypto = globalThis.crypto) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

/**
 * The URL the user is sent to. `callback_url` must be the extension's own
 * redirect URL, which only this extension can receive.
 */
export function authUrl({ callbackUrl, challenge, base = 'https://openrouter.ai/auth' }) {
  const url = new URL(base);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Pull the authorization code out of whatever the provider redirected to.
 * It may arrive as a query parameter or in the fragment, so check both rather
 * than assuming — a missed code looks like a silent sign-in failure.
 */
export function codeFromRedirect(redirectUrl) {
  if (!redirectUrl) return null;
  let url;
  try {
    url = new URL(redirectUrl);
  } catch {
    return null;
  }
  const fromQuery = url.searchParams.get('code');
  if (fromQuery) return fromQuery;
  const fragment = new URLSearchParams((url.hash || '').replace(/^#/, ''));
  return fragment.get('code') || null;
}
