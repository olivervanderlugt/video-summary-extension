// The service worker is the only file that touches an API key, and it is the
// one file that cannot be loaded in a browser test. A small `chrome` stub makes
// its message handlers drivable from node, which is enough to pin the
// properties that actually matter: no key reaches the page, no key reaches a
// host the user did not configure, and no path leaves a caller hanging.

import test from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'test-extension-id';

/** Captured listeners, so a test can play the content script or options page. */
const hooks = { message: [], connect: [] };
let storage = {};

globalThis.chrome = {
  runtime: {
    id: EXT_ID,
    onMessage: { addListener: (fn) => hooks.message.push(fn) },
    onConnect: { addListener: (fn) => hooks.connect.push(fn) },
    openOptionsPage: () => {},
    onInstalled: { addListener: () => {} },
  },
  storage: {
    local: {
      get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
      set: async (obj) => Object.assign(storage, obj),
    },
    session: { setAccessLevel: async () => {} },
  },
  action: { onClicked: { addListener: () => {} } },
};

await import('../src/background/worker.js');

/** Send a one-shot message the way chrome would, and await the reply. */
function send(msg, senderId = EXT_ID) {
  return new Promise((resolve) => {
    let answered = false;
    const kept = hooks.message[0](msg, { id: senderId }, (payload) => {
      answered = true;
      resolve(payload);
    });
    // A handler that declines the message returns false and never responds.
    if (kept === false && !answered) resolve(undefined);
  });
}

function setSettings(patch) {
  storage = {
    settings: {
      provider: 'anthropic',
      keys: { anthropic: 'sk-ant-SECRET', openai: 'sk-openai-SECRET', gemini: 'AIza-SECRET', compatible: '' },
      model: '',
      baseUrl: '',
      lang: 'en',
      defaultMode: 'detailed',
      autoRun: false,
      maxTokens: 4000,
      ...patch,
    },
  };
}

test('getSettings never hands an API key to the content script', async () => {
  setSettings({});
  const reply = await send({ type: 'getSettings' });
  // An exact key set, deliberately: adding a field here should be a decision,
  // not something that slips in. `hasKey` is a boolean, never the key itself.
  assert.deepEqual(Object.keys(reply).sort(), ['autoRun', 'defaultMode', 'hasKey', 'lang']);
  assert.equal(reply.hasKey, true);
  assert.ok(!JSON.stringify(reply).includes('SECRET'), 'a key leaked into the reply');
});

test('getSettings reports a missing key without revealing anything', async () => {
  setSettings({ keys: { anthropic: '', openai: '', gemini: '', compatible: '' } });
  const reply = await send({ type: 'getSettings' });
  assert.equal(reply.hasKey, false);
});

test('a message from another extension is refused outright', async () => {
  setSettings({});
  const reply = await send({ type: 'getSettings' }, 'some-other-extension');
  assert.equal(reply, undefined);
});

test('a leftover baseUrl is not applied to a provider that does not use one', async () => {
  // The bug this pins: baseUrl is one stored field, so a URL left behind from a
  // session with a local proxy used to be handed the user's real Anthropic key.
  setSettings({ provider: 'anthropic', baseUrl: 'https://not-anthropic.example/v1' });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers || {} });
    return { ok: true, json: async () => ({ data: [{ id: 'claude-opus-5' }] }) };
  };

  const reply = await send({ type: 'listModels' });
  assert.equal(reply.ok, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith('https://api.anthropic.com/'), `went to ${seen[0].url}`);
  assert.ok(!seen[0].url.includes('not-anthropic.example'));
});

test('the compatible provider does use its baseUrl', async () => {
  setSettings({ provider: 'compatible', baseUrl: 'http://localhost:11434/v1', keys: { compatible: 'k' } });
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, json: async () => ({ data: [{ id: 'llama' }] }) };
  };

  await send({ type: 'listModels' });
  assert.ok(seen[0].startsWith('http://localhost:11434/v1'), `went to ${seen[0]}`);
});

test('caller-supplied settings cannot redirect a key-bearing request', async () => {
  setSettings({ provider: 'openai' });
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, json: async () => ({ data: [] }) };
  };

  await send({ type: 'listModels', settings: { baseUrl: 'https://attacker.example/v1' } });
  assert.ok(!seen[0].includes('attacker.example'), `went to ${seen[0]}`);
});

test('a non-JSON 200 answers with an error instead of hanging', async () => {
  // A misconfigured base URL, a captive portal, or a proxy returning HTML used
  // to reject inside the handler, so sendResponse was never called and the
  // options page span forever on "Testing…".
  setSettings({ provider: 'compatible', baseUrl: 'http://localhost:1/v1', keys: { compatible: 'k' } });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  });

  const reply = await send({ type: 'testKey' });
  assert.equal(reply.ok, false);
  assert.ok(reply.message, 'an unreachable provider must still explain itself');
});

test('an unknown message type still gets an answer', async () => {
  setSettings({});
  const reply = await send({ type: 'no-such-thing' });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'UNKNOWN_MESSAGE');
});

test('a run with no key reports it rather than failing silently', async () => {
  setSettings({ keys: { anthropic: '' } });
  const posted = [];
  const port = {
    name: 'vse',
    postMessage: (m) => posted.push(m),
    onMessage: { addListener: (fn) => (port._recv = fn) },
    onDisconnect: { addListener: () => {} },
  };
  hooks.connect[0](port);

  port._recv({
    type: 'run',
    json3: { events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'hello' }] }] },
    trackInfo: { languageCode: 'en' },
    mode: 'brief',
  });
  await new Promise((r) => setTimeout(r, 30));

  const error = posted.find((m) => m.type === 'error');
  assert.ok(error, `expected an error, got ${JSON.stringify(posted.map((m) => m.type))}`);
  assert.equal(error.code, 'NO_KEY');
});

test('a malformed begin reports an error instead of leaving the panel spinning', async () => {
  setSettings({});
  const posted = [];
  const port = {
    name: 'vse',
    postMessage: (m) => posted.push(m),
    onMessage: { addListener: (fn) => (port._recv = fn) },
    onDisconnect: { addListener: () => {} },
  };
  hooks.connect[0](port);

  // A track list that is an object rather than an array: whatever this does, it
  // must end in a message, never in an unhandled rejection.
  port._recv({ type: 'begin', meta: { title: 't', duration: 100 }, tracks: { nope: true } });
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(posted.length > 0, 'begin produced no reply at all');
  assert.ok(
    posted.some((m) => m.type === 'error' || m.type === 'fetchTrack'),
    `unexpected reply: ${JSON.stringify(posted)}`
  );
});

// ---------------------------------------------------------------------------
// OpenRouter sign-in (PKCE).
//
// This is the one flow where a bug hands the user a broken extension that looks
// signed in: an empty key stored under `openrouter` with the provider switched
// over reads as success in the options page and then fails on every summary. So
// every failure case below asserts on storage as well as on the reply.
// ---------------------------------------------------------------------------

import { challengeFor } from '../src/lib/pkce.js';

/** Scripted outcome for launchWebAuthFlow, plus a record of what it was asked. */
const auth = { calls: [], redirect: null, error: null };

chrome.identity = {
  getRedirectURL: (path = '') => `https://${EXT_ID}.chromiumapp.org/${path}`,
  launchWebAuthFlow: async (options) => {
    auth.calls.push(options);
    if (auth.error) throw auth.error;
    return auth.redirect;
  },
};

/** Point the flow at an outcome and stub the token exchange in one place. */
function scriptSignIn({ redirect = null, error = null, exchange }) {
  auth.calls.length = 0;
  auth.redirect = redirect;
  auth.error = error;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), init });
    return exchange ? exchange() : { ok: true, json: async () => ({ key: 'sk-or-MINTED' }) };
  };
  return posts;
}

/** The challenge the user's browser was actually sent to OpenRouter with. */
function sentChallenge() {
  return new URL(auth.calls[0].url).searchParams.get('code_challenge');
}

test('signing in stores the minted key and switches to OpenRouter', async () => {
  setSettings({ provider: 'anthropic' });
  scriptSignIn({ redirect: `https://${EXT_ID}.chromiumapp.org/?code=AUTH_CODE` });

  const reply = await send({ type: 'signIn' });
  assert.equal(reply.ok, true, `sign-in failed: ${JSON.stringify(reply)}`);

  // Assert on storage, not on the reply: the reply is what the options page
  // shows, storage is what every later summary actually reads.
  assert.equal(storage.settings.keys.openrouter, 'sk-or-MINTED');
  assert.equal(storage.settings.provider, 'openrouter');
  // The keys the user already had must survive being handed a new one.
  assert.equal(storage.settings.keys.anthropic, 'sk-ant-SECRET');
});

test('the token exchange sends the verifier, not the challenge', async () => {
  setSettings({});
  const posts = scriptSignIn({ redirect: `https://${EXT_ID}.chromiumapp.org/?code=AUTH_CODE` });

  await send({ type: 'signIn' });

  assert.equal(posts.length, 1, 'expected exactly one call to the token endpoint');
  assert.equal(posts[0].url, 'https://openrouter.ai/api/v1/auth/keys');
  assert.equal(posts[0].init.method, 'POST');

  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.code, 'AUTH_CODE');
  assert.equal(body.code_challenge_method, 'S256');
  assert.ok(body.code_verifier, 'no code_verifier was sent');

  // The whole security value of PKCE is that the second leg proves knowledge of
  // the secret behind the first leg's hash. Sending the challenge back is a
  // real mistake — it round-trips cleanly and proves nothing — so pin both that
  // they differ and that the verifier actually hashes to what was sent.
  const challenge = sentChallenge();
  assert.notEqual(body.code_verifier, challenge, 'the challenge was sent as the verifier');
  assert.equal(await challengeFor(body.code_verifier), challenge, 'verifier does not match the challenge');
});

test('each sign-in uses a fresh verifier', async () => {
  setSettings({});
  const first = scriptSignIn({ redirect: `https://${EXT_ID}.chromiumapp.org/?code=A` });
  await send({ type: 'signIn' });
  const second = scriptSignIn({ redirect: `https://${EXT_ID}.chromiumapp.org/?code=B` });
  await send({ type: 'signIn' });

  assert.notEqual(
    JSON.parse(first[0].init.body).code_verifier,
    JSON.parse(second[0].init.body).code_verifier
  );
});

test('closing the sign-in window is reported as cancelled and changes nothing', async () => {
  setSettings({ provider: 'anthropic' });
  const before = JSON.stringify(storage);
  const posts = scriptSignIn({ error: new Error('The user cancelled the sign-in flow.') });

  const reply = await send({ type: 'signIn' });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'CANCELLED');
  assert.equal(posts.length, 0, 'a cancelled flow still hit the token endpoint');
  assert.equal(JSON.stringify(storage), before, 'a cancelled sign-in modified stored settings');
});

test('a redirect with no code fails clearly and changes nothing', async () => {
  setSettings({ provider: 'anthropic' });
  const before = JSON.stringify(storage);
  const posts = scriptSignIn({ redirect: `https://${EXT_ID}.chromiumapp.org/?error=access_denied` });

  const reply = await send({ type: 'signIn' });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'NO_CODE');
  assert.match(reply.message, /\S/);
  assert.equal(posts.length, 0, 'exchanged a code that was never returned');
  assert.equal(JSON.stringify(storage), before);
});

test('a refused exchange explains itself and changes nothing', async () => {
  setSettings({ provider: 'anthropic' });
  const before = JSON.stringify(storage);
  scriptSignIn({
    redirect: `https://${EXT_ID}.chromiumapp.org/?code=AUTH_CODE`,
    exchange: () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
  });

  const reply = await send({ type: 'signIn' });
  assert.equal(reply.ok, false);
  // The user cannot act on a stack trace. They can act on "try again, or paste
  // a key instead", which is the fallback the options page still offers.
  assert.match(reply.message, /try again|paste a key/i, `unhelpful message: ${reply.message}`);
  assert.ok(!reply.message.includes('undefined'), `leaked internals: ${reply.message}`);
  assert.equal(JSON.stringify(storage), before);
});

test('an exchange that returns no key stores nothing', async () => {
  setSettings({ provider: 'anthropic' });
  const before = JSON.stringify(storage);
  scriptSignIn({
    redirect: `https://${EXT_ID}.chromiumapp.org/?code=AUTH_CODE`,
    exchange: () => ({ ok: true, json: async () => ({ user_id: 'u_1' }) }),
  });

  const reply = await send({ type: 'signIn' });
  assert.equal(reply.ok, false);
  // Storing '' here would flip the provider to openrouter and read as signed
  // in, then fail on every single summary with a key error.
  assert.equal(JSON.stringify(storage), before, 'an empty key was stored');
  assert.notEqual(storage.settings.provider, 'openrouter');
});

test('an empty-string key from the exchange is refused too', async () => {
  setSettings({ provider: 'anthropic' });
  const before = JSON.stringify(storage);
  scriptSignIn({
    redirect: `https://${EXT_ID}.chromiumapp.org/?code=AUTH_CODE`,
    exchange: () => ({ ok: true, json: async () => ({ key: '' }) }),
  });

  const reply = await send({ type: 'signIn' });
  assert.equal(reply.ok, false);
  assert.equal(JSON.stringify(storage), before);
});

test('a non-JSON 200 from the token endpoint fails instead of throwing', async () => {
  // A captive portal or a proxy answering with HTML: the handler must still
  // reply, or the options page sits on "Signing in…" with nothing to click.
  setSettings({ provider: 'anthropic' });
  const before = JSON.stringify(storage);
  scriptSignIn({
    redirect: `https://${EXT_ID}.chromiumapp.org/?code=AUTH_CODE`,
    exchange: () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }),
  });

  const reply = await send({ type: 'signIn' });
  assert.equal(reply.ok, false);
  // Handled by the sign-in path itself, not by the worker's outermost catch:
  // that fallback answers "The extension hit an unexpected error: Unexpected
  // token <", which tells the user nothing they can do anything about.
  assert.equal(reply.code, 'EXCHANGE_FAILED', `fell through to the generic handler: ${JSON.stringify(reply)}`);
  assert.match(reply.message, /try again|paste a key/i, `unhelpful message: ${reply.message}`);
  assert.ok(!/unexpected token/i.test(reply.message), `leaked a parser error: ${reply.message}`);
  assert.equal(JSON.stringify(storage), before);
});

test('the authorization URL goes to OpenRouter with the extension redirect', async () => {
  setSettings({});
  scriptSignIn({ redirect: `https://${EXT_ID}.chromiumapp.org/?code=AUTH_CODE` });
  await send({ type: 'signIn' });

  const url = new URL(auth.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth');
  assert.equal(url.searchParams.get('callback_url'), `https://${EXT_ID}.chromiumapp.org/`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.calls[0].interactive, true, 'a sign-in the user cannot see cannot be completed');
});

test('a fresh install defaults to the provider you can sign in to', async () => {
  // Nobody has an API key on day one. The default has to be the one that does
  // not require going and finding one.
  storage = {};
  const reply = await send({ type: 'getSettings' });
  assert.equal(reply.hasKey, false);

  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, json: async () => ({ data: [] }) };
  };
  // With no stored settings at all, the worker must still resolve a provider.
  await send({ type: 'listModels' });
  assert.equal(seen.length, 0, 'no key yet, so nothing should have been requested');
});
