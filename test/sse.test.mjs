import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sseEvents, streamFromString } from '../src/lib/sse.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

async function collect(text, chunkSize) {
  const out = [];
  for await (const event of sseEvents(streamFromString(text, chunkSize))) out.push(event);
  return out;
}

test('parses events, joins multi-line data, skips comments and malformed payloads', async () => {
  assert.deepEqual(await collect(fixture('sse-generic.txt')), [{ n: 1 }, { a: 2 }, { n: 3 }]);
});

test('[DONE] stops iteration and is never yielded', async () => {
  const events = await collect(fixture('sse-generic.txt'));
  assert.ok(!events.some((e) => e && e.never)); // fixture has an event after [DONE]
  // The sentinel itself must not surface as a value either: a consumer that
  // gets '[DONE]' handed to it as an event treats it as a delta and prints it.
  assert.equal(events.length, 3, `yielded ${JSON.stringify(events)}`);
});

test('one byte at a time yields exactly the same events as one whole chunk', async () => {
  const text = fixture('sse-generic.txt');
  assert.deepEqual(await collect(text, 1), await collect(text));
});

test('every chunk size from 1..40 yields identical events', async () => {
  const text = fixture('anthropic-stream.txt');
  const whole = await collect(text);
  for (let size = 1; size <= 40; size++) {
    assert.deepEqual(await collect(text, size), whole, `chunk size ${size}`);
  }
});

test('a JSON object split mid-token still parses', async () => {
  const text = 'data: {"text":"hello world"}\n\n';
  for (let size = 1; size <= text.length; size++) {
    assert.deepEqual(await collect(text, size), [{ text: 'hello world' }]);
  }
});

test('handles CRLF separators, including a \\r\\n split across chunks', async () => {
  const text = fixture('sse-crlf.txt');
  const expected = [{ n: 1 }, { a: 2 }, { n: 3 }];
  assert.deepEqual(await collect(text), expected);
  assert.deepEqual(await collect(text, 1), expected);
});

test('flushes a trailing event that has no blank line after it', async () => {
  assert.deepEqual(await collect(fixture('sse-trailing.txt')), [{ n: 1 }, { last: true }]);
});

test('a malformed payload does not kill the rest of the stream', async () => {
  const text = 'data: {"a":1}\n\ndata: not-json\n\ndata: {"b":2}\n\n';
  assert.deepEqual(await collect(text), [{ a: 1 }, { b: 2 }]);
});

test('comment-only and empty blocks yield nothing', async () => {
  assert.deepEqual(await collect(': keep-alive\n\n\n\n: another\n\n'), []);
});

test('data field with no space after the colon is accepted', async () => {
  assert.deepEqual(await collect('data:{"a":1}\n\n'), [{ a: 1 }]);
});

test('empty stream yields nothing', async () => {
  assert.deepEqual(await collect(''), []);
});
