// PKCE is the one part of the sign-in flow with no visible failure mode during
// development: plain base64 looks like base64url, a verifier of the wrong
// length looks like a verifier, and both work right up until the provider
// rejects the exchange in a user's browser. So every assertion here is against
// RFC 7636 or an independently computed value, never against the helper itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { base64url, createVerifier, challengeFor, authUrl, codeFromRedirect } from '../src/lib/pkce.js';

// RFC 7636 §A: unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
const UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

test('base64url substitutes both non-URL-safe characters and drops padding', () => {
  // These two bytes are chosen because standard base64 encodes them as "+/8=":
  // one "+", one "/", and one "=" — every substitution the RFC requires, in a
  // three-character string. Plain btoa here would silently produce a value the
  // authorization server rejects.
  const bytes = new Uint8Array([0xfb, 0xff]);
  assert.equal(Buffer.from(bytes).toString('base64'), '+/8=', 'test vector no longer exercises + / and =');

  const out = base64url(bytes);
  assert.equal(out, '-_8');
  assert.ok(!out.includes('+'), '"+" was not replaced with "-"');
  assert.ok(!out.includes('/'), '"/" was not replaced with "_"');
  assert.ok(!out.includes('='), 'padding was not stripped');
});

test('base64url leaves already-safe input alone and round-trips', () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x7f, 0x80, 0xff]);
  const out = base64url(bytes);
  assert.match(out, /^[A-Za-z0-9\-_]+$/);
  assert.deepEqual(new Uint8Array(Buffer.from(out, 'base64url')), bytes);
});

test('base64url handles every padding length', () => {
  // 1, 2 and 3 bytes hit the two-pad, one-pad and no-pad cases respectively.
  for (const n of [1, 2, 3]) {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe].slice(0, n));
    const out = base64url(bytes);
    assert.ok(!out.includes('='), `padding survived for ${n} byte(s): ${out}`);
    assert.equal(out, Buffer.from(bytes).toString('base64url'));
  }
});

test('createVerifier stays inside RFC 7636 length and character limits', () => {
  const verifier = createVerifier();
  assert.ok(verifier.length >= 43, `verifier too short: ${verifier.length}`);
  assert.ok(verifier.length <= 128, `verifier too long: ${verifier.length}`);
  assert.match(verifier, UNRESERVED, `verifier contains a reserved character: ${verifier}`);
});

test('createVerifier is different every time', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(createVerifier());
  // A constant or a low-entropy verifier defeats the entire point of PKCE.
  assert.equal(seen.size, 50, 'createVerifier repeated a value');
});

test('challengeFor matches an independently computed SHA-256', async () => {
  const verifier = createVerifier();
  // Computed with node:crypto, not with base64url() — reusing the helper under
  // test to build the expectation would pass even if both halves were wrong.
  const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  assert.equal(await challengeFor(verifier), expected);
});

test('challengeFor reproduces the RFC 7636 Appendix B vector', async () => {
  assert.equal(
    await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  );
});

test('challengeFor is a hash, not a passthrough', async () => {
  const verifier = createVerifier();
  const challenge = await challengeFor(verifier);
  assert.notEqual(challenge, verifier, 'the challenge is the verifier — nothing was hashed');
  assert.equal(challenge.length, 43, 'a base64url SHA-256 is always 43 characters');
  assert.match(challenge, UNRESERVED);
});

test('authUrl carries the callback, the challenge and the S256 method', () => {
  const url = new URL(
    authUrl({ callbackUrl: 'https://abc.chromiumapp.org/', challenge: 'CHALLENGE' })
  );
  assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth');
  assert.equal(url.searchParams.get('callback_url'), 'https://abc.chromiumapp.org/');
  assert.equal(url.searchParams.get('code_challenge'), 'CHALLENGE');
  // "plain" would send the verifier itself over the wire in the first leg.
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('authUrl escapes a callback URL that needs escaping', () => {
  // A redirect URL with its own query string is the case that breaks naive
  // string concatenation: the "&" would end up starting a parameter of the
  // authorization URL instead of staying inside callback_url.
  const callbackUrl = 'https://abc.chromiumapp.org/cb?next=a b&who=me/you';
  const raw = authUrl({ callbackUrl, challenge: 'C' });

  assert.ok(raw.includes('%3A%2F%2F'), `"://" was not escaped: ${raw}`);
  assert.ok(!raw.includes('&who=me'), `the callback query leaked into the auth URL: ${raw}`);
  const parsed = new URL(raw);
  assert.equal(parsed.searchParams.get('callback_url'), callbackUrl);
  assert.equal(parsed.searchParams.get('who'), null);
  assert.equal(parsed.searchParams.get('code_challenge'), 'C');
});

test('codeFromRedirect reads a code from the query string', () => {
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/?code=abc123'), 'abc123');
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/?state=x&code=abc123&y=1'), 'abc123');
});

test('codeFromRedirect reads a code from the fragment', () => {
  // Some providers answer in the fragment; missing that reads as a silent
  // sign-in failure with no error to show the user.
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/#code=frag456'), 'frag456');
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/#state=x&code=frag456'), 'frag456');
});

test('codeFromRedirect returns null when there is no code', () => {
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/'), null);
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/?error=access_denied'), null);
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/#error=access_denied'), null);
  assert.equal(codeFromRedirect('https://abc.chromiumapp.org/?code='), null);
});

test('codeFromRedirect returns null for junk instead of throwing', () => {
  // launchWebAuthFlow resolves with undefined when the flow ends without a
  // redirect, so this path is reached in normal use, not only in tests.
  for (const junk of [undefined, null, '', 'not a url', 'chromiumapp.org/?code=x']) {
    assert.equal(codeFromRedirect(junk), null, `threw or matched on ${JSON.stringify(junk)}`);
  }
});
