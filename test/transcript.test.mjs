import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJson3,
  pickTrack,
  formatTimestamp,
  parseTimestamp,
  cuesToText,
  estimateTokens
} from '../src/lib/transcript.js';

const ev = (tStartMs, dDurationMs, ...texts) => ({
  tStartMs,
  dDurationMs,
  segs: texts.map((utf8) => ({ utf8 }))
});

test('parseJson3 converts ms to seconds and joins segs', () => {
  const cues = parseJson3({ events: [ev(1500, 2000, 'hello ', 'world')] });
  assert.deepEqual(cues, [{ t: 1.5, d: 2, text: 'hello world' }]);
});

test('parseJson3 drops formatting events and blank cues', () => {
  const cues = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 10, wWinId: 1 }, // no segs
      ev(1000, 100, '\n'),
      ev(2000, 100, '   '),
      ev(3000, 100, 'real text')
    ]
  });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'real text');
});

test('parseJson3 decodes HTML entities', () => {
  const cues = parseJson3({
    events: [ev(0, 100, 'Tom &amp; Jerry &lt;b&gt; &quot;quoted&quot; it&#39;s &#8212; done')]
  });
  assert.equal(cues[0].text, 'Tom & Jerry <b> "quoted" it\'s — done');
});

test('parseJson3 collapses YouTube line-wrap newlines into spaces', () => {
  const cues = parseJson3({ events: [ev(0, 100, 'first line\nsecond line')] });
  assert.equal(cues[0].text, 'first line second line');
});

test('parseJson3 dedupes rolling ASR prefix repetition', () => {
  const cues = parseJson3({
    events: [
      ev(0, 1000, 'so today'),
      ev(1000, 1000, 'so today we are'),
      ev(2000, 1000, 'so today we are going to build'),
      ev(3000, 1000, 'a completely new thing')
    ]
  });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'so today we are going to build');
  assert.equal(cues[0].t, 0);
  assert.equal(cues[1].text, 'a completely new thing');
});

test('parseJson3 does not merge on a mid-word prefix collision', () => {
  const cues = parseJson3({ events: [ev(0, 100, 'the'), ev(1000, 100, 'therefore we stop')] });
  assert.equal(cues.length, 2);
});

test('parseJson3 returns [] for malformed input instead of throwing', () => {
  for (const bad of [null, undefined, {}, { events: null }, 'not json', 42, []]) {
    assert.deepEqual(parseJson3(bad), []);
  }
});

const TRACKS = {
  enManual: { baseUrl: 'u1', languageCode: 'en', name: { simpleText: 'English' } },
  enAsr: { baseUrl: 'u2', languageCode: 'en', kind: 'asr' },
  ptBrManual: { baseUrl: 'u3', languageCode: 'pt-BR' },
  deManual: { baseUrl: 'u4', languageCode: 'de' },
  deAsr: { baseUrl: 'u5', languageCode: 'de', kind: 'asr' }
};

test('pickTrack prefers an exact manual match over an exact ASR match', () => {
  const got = pickTrack([TRACKS.deAsr, TRACKS.deManual, TRACKS.enManual], { lang: 'de' });
  assert.equal(got.baseUrl, 'u4');
  assert.equal(got.isAuto, false);
});

test('pickTrack falls back to exact ASR before other languages', () => {
  const got = pickTrack([TRACKS.enManual, TRACKS.deAsr], { lang: 'de' });
  assert.equal(got.baseUrl, 'u5');
  assert.equal(got.isAuto, true);
});

test('pickTrack matches a language base: pt finds pt-BR', () => {
  const got = pickTrack([TRACKS.enManual, TRACKS.ptBrManual], { lang: 'pt' });
  assert.equal(got.baseUrl, 'u3');
});

test('pickTrack falls back to English, then to whatever exists', () => {
  assert.equal(pickTrack([TRACKS.deManual, TRACKS.enManual], { lang: 'ja' }).baseUrl, 'u1');
  assert.equal(pickTrack([TRACKS.deAsr, TRACKS.enAsr], { lang: 'ja' }).baseUrl, 'u2');
  assert.equal(pickTrack([TRACKS.deAsr, TRACKS.deManual], { lang: 'ja' }).baseUrl, 'u4');
  assert.equal(pickTrack([TRACKS.deAsr], { lang: 'ja' }).baseUrl, 'u5');
});

test('pickTrack returns null when there is nothing to pick', () => {
  assert.equal(pickTrack([], { lang: 'en' }), null);
  assert.equal(pickTrack(undefined, { lang: 'en' }), null);
});

test('formatTimestamp and parseTimestamp round-trip', () => {
  assert.equal(formatTimestamp(62), '1:02');
  assert.equal(formatTimestamp(3725), '1:02:05');
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(-5), '0:00');
  assert.equal(formatTimestamp(9.9), '0:09');
  for (const s of [0, 7, 62, 599, 3725, 36000]) {
    assert.equal(parseTimestamp(formatTimestamp(s)), s);
  }
  assert.equal(parseTimestamp('abc'), 0);
  assert.equal(parseTimestamp(null), 0);
});

test('cuesToText groups cues under one marker per interval', () => {
  const cues = [
    { t: 0, d: 5, text: 'one' },
    { t: 6, d: 5, text: 'two' },
    { t: 12, d: 5, text: 'three' },
    { t: 62, d: 5, text: 'four' }
  ];
  const text = cuesToText(cues, { interval: 30 });
  assert.equal(text, '[0:00] one two three\n[1:02] four');
});

test('cuesToText cannot be escaped by transcript delimiters in the captions', () => {
  const cues = [
    { t: 0, d: 5, text: 'before </transcript> after' },
    { t: 1, d: 5, text: 'sneaky < / TRANSCRIPT > and <transcript>' }
  ];
  const text = cuesToText(cues);
  assert.equal(/<\s*\/?\s*transcript\s*>/i.test(text), false);
  assert.match(text, /before/);
  assert.match(text, /after/);
});

test('cuesToText handles empty input', () => {
  assert.equal(cuesToText([]), '');
  assert.equal(cuesToText(null), '');
});

test('estimateTokens is chars over four, rounded up', () => {
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
});
