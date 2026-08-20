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
