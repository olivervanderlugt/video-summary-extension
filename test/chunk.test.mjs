import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkCues } from '../src/lib/chunk.js';

/** One cue every `step` seconds. */
const makeCues = (n, step = 3, text = 'some spoken words here') =>
  Array.from({ length: n }, (_, i) => ({ t: i * step, d: step, text: `${text} ${i}` }));

test('empty input yields no chunks', () => {
  assert.deepEqual(chunkCues([]), []);
  assert.deepEqual(chunkCues(null), []);
});

test('a short video is one chunk, unchanged', () => {
  const cues = makeCues(20);
  const chunks = chunkCues(cues);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].cues, cues);
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].total, 1);
  assert.equal(chunks[0].startT, 0);
  assert.equal(chunks[0].endT, 60);
});

test('every cue survives chunking', () => {
  const cues = makeCues(600); // 30 minutes at 3s a cue
  const chunks = chunkCues(cues);
  assert.ok(chunks.length > 1);
  const seen = new Set(chunks.flatMap((c) => c.cues));
  for (const cue of cues) assert.ok(seen.has(cue), `cue at ${cue.t} was dropped`);
});

test('consecutive chunks overlap', () => {
  const chunks = chunkCues(makeCues(600), { windowSeconds: 480, overlapSeconds: 30 });
  for (let i = 1; i < chunks.length; i++) {
    const prev = new Set(chunks[i - 1].cues);
    const shared = chunks[i].cues.filter((c) => prev.has(c));
    assert.ok(shared.length > 0, `chunk ${i} shares nothing with ${i - 1}`);
    assert.ok(chunks[i].startT < chunks[i - 1].endT, 'boundaries should overlap in time');
  }
});

test('no chunk is empty and indexes are consistent', () => {
  const chunks = chunkCues(makeCues(600));
  chunks.forEach((c, i) => {
    assert.ok(c.cues.length > 0);
    assert.equal(c.index, i);
    assert.equal(c.total, chunks.length);
    assert.ok(c.endT >= c.startT);
  });
});

test('time windows are respected', () => {
  const chunks = chunkCues(makeCues(600), { windowSeconds: 480, overlapSeconds: 30 });
  for (const c of chunks) {
    const span = c.cues[c.cues.length - 1].t - c.cues[0].t;
    assert.ok(span < 480 + 30, `chunk spans ${span}s`);
  }
});

test('maxChars splits a dense window that fits in time but not in budget', () => {
  // 100 cues in 100 seconds, 200 chars each: one time window, 20k chars.
  const cues = Array.from({ length: 100 }, (_, i) => ({ t: i, d: 1, text: 'x'.repeat(200) }));
  const chunks = chunkCues(cues, { maxChars: 5000, windowSeconds: 480, overlapSeconds: 5 });
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`);
  for (const c of chunks) {
    const chars = c.cues.reduce((n, cue) => n + cue.text.length + 1, 0);
    assert.ok(chars <= 5000, `chunk holds ${chars} chars`);
  }
  const seen = new Set(chunks.flatMap((c) => c.cues));
  assert.equal(seen.size, cues.length);
});

test('a single cue larger than maxChars still comes back', () => {
  const cues = [{ t: 0, d: 1, text: 'y'.repeat(9000) }];
  const chunks = chunkCues(cues, { maxChars: 100 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].cues.length, 1);
});
