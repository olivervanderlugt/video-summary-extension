// src/content/inject.js runs in the page's MAIN world, where every script
// youtube.com loads can read whatever it defines. So it exports nothing, has no
// test hook, and must keep it that way — adding one would hand the page a
// handle on the extension. Its pure logic is still testable: lift the piece
// under test out of the source text and evaluate that under node:vm.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseTimestamp as libParseTimestamp } from '../src/lib/transcript.js';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/content/inject.js', import.meta.url)),
  'utf8'
);

/** Evaluate one declaration from inject.js in isolation, and hand it back. */
function lift(name, pattern) {
  const match = SOURCE.match(pattern);
  // Without this the tests below would pass on an empty match forever.
  assert.ok(match, `${name} is no longer where this test looks for it in inject.js`);
  // The page globals the lifted code could touch, stubbed to nothing useful.
  return vm.runInNewContext(`${match[0]}\n;${name};`, { window: {}, document: {} });
}

const parseTimestamp = lift('parseTimestamp', /function parseTimestamp\(raw\)[\s\S]*?\n {2}\}/);
const TRANSCRIPT_WORD = lift('TRANSCRIPT_WORD', /const TRANSCRIPT_WORD =[\s\S]*?\/[a-z]*;/);

test('parseTimestamp reads the timestamps YouTube renders in its panel', () => {
  assert.equal(parseTimestamp('0:00'), 0);
  assert.equal(parseTimestamp('1:23'), 83);
  assert.equal(parseTimestamp('12:34:56'), 45296);
  assert.equal(parseTimestamp(' 2:00 '), 120);
  // Live streams and premieres render negative offsets.
  assert.equal(parseTimestamp('-0:05'), -5);
});

test('an unreadable timestamp is NaN here and 0 in the lib — deliberately', () => {
  // These two parsers are a deliberate twin pair, documented as such in both
  // files. Do NOT "unify" them: inject.js is a world:MAIN classic script that
  // cannot import the ESM lib, and NaN is the point — a garbled panel row gets
  // dropped, where the lib's 0 would silently invent a cue at the start of the
  // video and hang a summary claim off a timestamp nobody said anything at.
  for (const bad of ['', '  ', 'abc', '1:ab', 'Transcript', undefined, null]) {
    assert.ok(Number.isNaN(parseTimestamp(bad)), `${JSON.stringify(bad)} should be NaN`);
    assert.equal(libParseTimestamp(bad), 0, `${JSON.stringify(bad)} should be 0 in the lib`);
  }
});

test('the transcript button is recognised in the languages YouTube ships', () => {
  // The pattern was widened after the Russian word it carried ("стенограмма")
  // turned out to match nothing on the real UI — it says "текст видео". These
  // are the labels as YouTube writes them, not translations of "transcript".
  const labels = {
    en: 'Show transcript',
    ru: 'Показать текст видео',
    ko: '스크립트 표시',
    vi: 'Hiển thị bản chép lời',
    hi: 'ट्रांसक्रिप्ट दिखाएं',
    ar: 'إظهار النص',
    ja: '文字起こしを表示',
    nl: 'Transcript tonen',
  };
  for (const [lang, label] of Object.entries(labels)) {
    assert.ok(TRANSCRIPT_WORD.test(label), `${lang}: "${label}" did not match`);
  }
});

test('the transcript pattern does not grab a neighbouring button', () => {
  // It is matched against every button on the watch page. A false positive
  // clicks something else on the user's behalf.
  for (const label of ['Subscribe', 'Share', 'Save', 'Abonneren', 'Показать описание', '설정']) {
    assert.ok(!TRANSCRIPT_WORD.test(label), `"${label}" matched the transcript pattern`);
  }
});
