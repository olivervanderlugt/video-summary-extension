import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sseEvents, streamFromString } from '../src/lib/sse.js';
import { PROVIDERS, getProvider } from '../src/providers/index.js';
import * as anthropic from '../src/providers/anthropic.js';
import * as openai from '../src/providers/openai.js';
import * as gemini from '../src/providers/gemini.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const EXPECTED = 'Streaming works across chunk boundaries.';

/** Run a fixture through the parser + adapter, one byte at a time. */
async function streamText(provider, name) {
  let out = '';
  for await (const event of sseEvents(streamFromString(fixture(name), 1))) {
    out += provider.extractDelta(event);
  }
  return out;
}

const REQ = {
  key: 'test-key',
  model: 'test-model',
  system: 'You summarise videos.',
  messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
  ],
  maxTokens: 1234,
};

// --- registry ---------------------------------------------------------------

test('registry exposes the five providers with a consistent interface', () => {
  // Order matters: it is the order the settings page lists them, and the
  // sign-in provider leads because most people have never made an API key.
  assert.deepEqual(Object.keys(PROVIDERS), ['openrouter', 'anthropic', 'openai', 'gemini', 'compatible']);
  assert.equal(Object.keys(PROVIDERS)[0], 'openrouter');
  for (const [key, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, key, `${key}.id`);
    assert.equal(typeof p.label, 'string');
    assert.ok(Array.isArray(p.fallbackModels));
    for (const fn of ['buildRequest', 'buildModelsRequest', 'parseModels', 'extractDelta', 'parseError']) {
      assert.equal(typeof p[fn], 'function', `${key}.${fn}`);
    }
  }
});

test('getProvider throws a clear error on an unknown id', () => {
  assert.equal(getProvider('gemini'), PROVIDERS.gemini);
  assert.throws(() => getProvider('nope'), /Unknown AI provider "nope"/);
});

test('compatible is derived from openai, not copy-pasted', () => {
  assert.equal(PROVIDERS.compatible.buildRequest, openai.buildRequest);
  assert.equal(PROVIDERS.compatible.extractDelta, openai.extractDelta);
  assert.equal(PROVIDERS.compatible.origin, null);
  assert.equal(PROVIDERS.compatible.requiresBaseUrl, true);
  assert.match(PROVIDERS.compatible.label, /OpenAI-compatible/);
});

// --- anthropic --------------------------------------------------------------

test('anthropic buildRequest: url, exact headers, body shape', () => {
  const { url, headers, body } = anthropic.buildRequest(REQ);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(headers, {
    'content-type': 'application/json',
    'x-api-key': 'test-key',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  });
  assert.deepEqual(JSON.parse(body), {
    model: 'test-model',
    max_tokens: 1234,
    stream: true,
    messages: REQ.messages,
    system: REQ.system,
  });
});

test('anthropic buildModelsRequest keeps the auth headers', () => {
  const { url, headers } = anthropic.buildModelsRequest({ key: 'test-key' });
  assert.equal(url, 'https://api.anthropic.com/v1/models');
  assert.equal(headers['x-api-key'], 'test-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
});

test('anthropic stream fixture concatenates to the expected sentence', async () => {
  assert.equal(await streamText(anthropic, 'anthropic-stream.txt'), EXPECTED);
});

test('anthropic extractDelta returns "" for non-text events', () => {
  assert.equal(anthropic.extractDelta({ type: 'ping' }), '');
  assert.equal(anthropic.extractDelta({ type: 'message_start', message: {} }), '');
  assert.equal(anthropic.extractDelta({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }), '');
  assert.equal(anthropic.extractDelta({}), '');
});

test('anthropic treats an error event as fatal', () => {
  assert.throws(
    () => anthropic.extractDelta({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    /Overloaded/,
  );
});

test('anthropic parseModels sorts ids', () => {
  const models = anthropic.parseModels({
    data: [{ id: 'claude-sonnet-5', display_name: 'S' }, { id: 'claude-haiku-4-5' }, {}],
  });
  assert.deepEqual(models, ['claude-haiku-4-5', 'claude-sonnet-5']);
  assert.deepEqual(anthropic.parseModels({}), []);
});

// --- openai -----------------------------------------------------------------

test('openai buildRequest: url, bearer header, body shape with system first', () => {
  const { url, headers, body } = openai.buildRequest(REQ);
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(headers, { 'content-type': 'application/json', authorization: 'Bearer test-key' });
  assert.deepEqual(JSON.parse(body), {
    model: 'test-model',
    stream: true,
    messages: [{ role: 'system', content: REQ.system }, ...REQ.messages],
    max_completion_tokens: 1234,
  });
});

test('openai baseUrl normalisation', () => {
  const url = (baseUrl) => openai.buildRequest({ ...REQ, baseUrl }).url;
  assert.equal(url('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(url('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(url('http://localhost:1234/v1///'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(url('  https://proxy.corp/v1  '), 'https://proxy.corp/v1/chat/completions');
  // already the full endpoint — do not append a second path
  assert.equal(url('https://proxy.corp/v1/chat/completions'), 'https://proxy.corp/v1/chat/completions');
  assert.equal(url('https://proxy.corp/v1/chat/completions/'), 'https://proxy.corp/v1/chat/completions');
  assert.equal(url(''), 'https://api.openai.com/v1/chat/completions');
});

test('openai models url is derived from the same baseUrl', () => {
  const url = (baseUrl) => openai.buildModelsRequest({ key: 'k', baseUrl }).url;
  assert.equal(url(), 'https://api.openai.com/v1/models');
  assert.equal(url('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1/models');
  assert.equal(url('https://proxy.corp/v1/chat/completions'), 'https://proxy.corp/v1/models');
  assert.deepEqual(openai.buildModelsRequest({ key: '' }).headers, {}); // local servers need no key
});

test('openai stream fixture concatenates to the expected sentence', async () => {
  assert.equal(await streamText(openai, 'openai-stream.txt'), EXPECTED);
});

test('openai extractDelta returns "" for non-text events', () => {
  assert.equal(openai.extractDelta({ choices: [{ delta: {}, finish_reason: 'stop' }] }), '');
  assert.equal(openai.extractDelta({ choices: [] }), '');
  assert.equal(openai.extractDelta({ choices: [{ delta: { tool_calls: [] } }] }), '');
  assert.equal(openai.extractDelta({}), '');
});

test('openai parseModels drops non-text models and sorts', () => {
  const models = openai.parseModels({
    data: [
      { id: 'gpt-5' },
      { id: 'whisper-1' },
      { id: 'text-embedding-3-large' },
      { id: 'dall-e-3' },
      { id: 'gpt-4o-mini' },
      { id: 'omni-moderation-latest' },
      { id: 'gpt-4o-realtime-preview' },
      {},
    ],
  });
  assert.deepEqual(models, ['gpt-4o-mini', 'gpt-5']);
  assert.deepEqual(openai.parseModels(null), []);
});

// --- gemini -----------------------------------------------------------------

test('gemini buildRequest: url, key in the header not the query, role mapping', () => {
  const { url, headers, body } = gemini.buildRequest(REQ);
  assert.equal(
    url,
    'https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse',
  );
  assert.ok(!url.includes('test-key'), 'the key must never appear in the URL');
  assert.deepEqual(headers, { 'content-type': 'application/json', 'x-goog-api-key': 'test-key' });
  assert.deepEqual(JSON.parse(body), {
    system_instruction: { parts: [{ text: REQ.system }] },
    contents: [
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'ok' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ],
    generationConfig: { maxOutputTokens: 1234 },
  });
});

test('gemini buildModelsRequest', () => {
  const { url, headers } = gemini.buildModelsRequest({ key: 'test-key' });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.deepEqual(headers, { 'x-goog-api-key': 'test-key' });
});

test('gemini stream fixture concatenates to the expected sentence', async () => {
  assert.equal(await streamText(gemini, 'gemini-stream.txt'), EXPECTED);
});

test('gemini extractDelta returns "" for non-text events', () => {
  assert.equal(gemini.extractDelta({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }), '');
  assert.equal(gemini.extractDelta({ usageMetadata: { totalTokenCount: 1 } }), '');
  assert.equal(gemini.extractDelta({}), '');
});

test('gemini surfaces blocked prompts and blocked finishes as errors', () => {
  assert.throws(() => gemini.extractDelta({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
  assert.throws(
    () => gemini.extractDelta({ candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }] }),
    /RECITATION/,
  );
});

test('gemini parseModels keeps only generateContent models and strips the prefix', () => {
  const models = gemini.parseModels({
    models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/no-methods' },
    ],
  });
  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.deepEqual(gemini.parseModels({}), []);
});

// --- errors -----------------------------------------------------------------

const ERROR_BODIES = {
  anthropic: JSON.stringify({ error: { type: 'invalid_request_error', message: 'prompt is too long' } }),
  openai: JSON.stringify({ error: { message: 'context_length_exceeded' } }),
  gemini: JSON.stringify({ error: { code: 400, message: 'API key not valid' } }),
};

for (const [name, provider] of Object.entries({ anthropic, openai, gemini })) {
  test(`${name} parseError gives one actionable sentence per status`, () => {
    const body = ERROR_BODIES[name];
    const seen = new Map();
    for (const status of [401, 429, 400, 500]) {
      const { code, message } = provider.parseError(status, body);
      assert.equal(typeof code, 'string');
      assert.ok(code.length > 0, `${status} needs a code`);
      assert.ok(message.length > 20, `${status} message too short: ${message}`);
      assert.ok(/[.?]$/.test(message.trim()), `${status} message is not a sentence: ${message}`);
      assert.ok(!seen.has(message), `${status} repeats the ${seen.get(message)} message`);
      seen.set(message, status);
    }
    assert.equal(provider.parseError(401, body).code, 'auth');
    assert.equal(provider.parseError(429, body).code, 'rate_limit');
    assert.equal(provider.parseError(500, body).code, 'server');
  });

  test(`${name} parseError surfaces the provider's own detail on 400`, () => {
    const detail = JSON.parse(ERROR_BODIES[name]).error.message;
    assert.ok(provider.parseError(400, ERROR_BODIES[name]).message.includes(detail));
  });

  test(`${name} parseError survives an unparseable body`, () => {
    for (const body of ['<html>502 Bad Gateway</html>', '', undefined]) {
      for (const status of [401, 400, 418, 503]) {
        const { code, message } = provider.parseError(status, body);
        assert.equal(typeof code, 'string');
        assert.ok(message.length > 20);
        assert.ok(!message.includes('undefined'), `leaked undefined: ${message}`);
      }
    }
    assert.equal(provider.parseError(418, '<html>').code, 'unknown');
    assert.match(provider.parseError(418, '<html>').message, /418/);
  });
}

test('openrouter is the openai wire format with a base URL it does not ask for', () => {
  const or = PROVIDERS.openrouter;
  // Derived, not copied: one implementation of the wire format.
  assert.equal(or.buildRequest, PROVIDERS.openai.buildRequest);
  assert.equal(or.supportsSignIn, true);
  assert.equal(or.requiresBaseUrl, false, 'a fixed base URL must not prompt the user for one');
  const { url } = or.buildRequest({
    key: 'sk-or-x',
    model: or.defaultModel,
    baseUrl: or.fixedBaseUrl,
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 10,
  });
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
});
