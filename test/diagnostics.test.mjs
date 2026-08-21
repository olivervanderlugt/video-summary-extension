// src/lib/diagnostics.js is loaded by Chrome as a classic content script, so it
// cannot carry `export` (a syntax error there) and this file cannot destructure
// it from an import. It hangs its surface on globalThis instead; importing the
// file for its side effect is what puts it there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import '../src/lib/diagnostics.js';

const { buildDiagnostics, formatDiagnostics, issueUrl, MAX_URL } = globalThis.VSE_DIAG;

const SECRET_KEY = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const input = () => ({
  version: '0.4.0',
  code: 'NO_TRANSCRIPT',
  title: 'YouTube would not hand over the transcript',
  message: 'This video has captions, but YouTube refused to serve their text.',
  videoId: 'aircAruvnKk',
  durationSeconds: 1140.6,
  trackCount: 2,
  strategy: 'captions',
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/126.0.0.0 Safari/537.36',
  language: 'en-GB',
  timestamp: '2026-08-21T09:00:00.000Z',
});

test('the file parses as a classic script — Chrome loads it as one', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/lib/diagnostics.js', import.meta.url)), 'utf8');
  // Throws on `import`/`export`, which would break the extension at load time
  // while leaving every test in this file green.
  new vm.Script(source);
});

test('every field the panel can offer comes through', () => {
  const d = buildDiagnostics(input());
  assert.deepEqual(Object.keys(d).sort(), [
    'code', 'durationSeconds', 'language', 'message', 'strategy',
    'timestamp', 'title', 'trackCount', 'userAgent', 'version', 'videoId',
  ].sort());
  assert.equal(d.version, '0.4.0');
  assert.equal(d.code, 'NO_TRANSCRIPT');
  assert.equal(d.videoId, 'aircAruvnKk');
  assert.equal(d.durationSeconds, 1141); // rounded, not the raw float
  assert.equal(d.trackCount, 2);
  assert.equal(d.strategy, 'captions');
  assert.equal(d.language, 'en-GB');
  assert.match(formatDiagnostics(d), /caption tracks: 2 listed/);
});

test('the allowlist: a key, a transcript and a summary cannot come out', () => {
  const d = buildDiagnostics({
    ...input(),
    apiKey: SECRET_KEY,
    key: SECRET_KEY,
    baseUrl: 'https://secret.internal.example/v1',
    transcript: 'the entire spoken text of the video',
    cues: [{ t: 0, d: 3, text: 'the entire spoken text of the video' }],
    text: 'the finished summary the user paid for',
    html: '<p>the finished summary the user paid for</p>',
    thread: [{ role: 'user', content: 'a private question' }],
  });
  const blob = `${JSON.stringify(d)}\n${formatDiagnostics(d)}\n${issueUrl(d)}`;
  for (const secret of [
    SECRET_KEY,
    'secret.internal.example',
    'the entire spoken text',
    'the finished summary',
    'a private question',
  ]) {
    assert.ok(!blob.includes(secret), `${secret} leaked into the diagnostics`);
    assert.ok(!blob.includes(encodeURIComponent(secret)), `${secret} leaked into the URL`);
  }
  for (const key of ['apiKey', 'baseUrl', 'transcript', 'cues', 'html', 'thread']) {
    assert.ok(!(key in d), `${key} should not be a field`);
  }
});

test('a key echoed back inside a provider error message is redacted', () => {
  // OpenAI's 401 body does exactly this, and the panel shows the provider's
  // own wording, so the allowlist alone would not have caught it.
  const d = buildDiagnostics({ ...input(), message: `Incorrect API key provided: ${SECRET_KEY}. Check it.` });
  assert.ok(!d.message.includes(SECRET_KEY));
  assert.ok(!d.message.includes('sk-proj-'));
  assert.match(d.message, /Incorrect API key provided: \[redacted\]/);
  assert.ok(!issueUrl(d).includes('sk-proj-'));
});

test('missing, unknown and hostile fields do not throw', () => {
  for (const bad of [undefined, null, {}, { code: null, durationSeconds: 'later', trackCount: 'many' }]) {
    const d = buildDiagnostics(bad);
    assert.equal(d.code, 'UNKNOWN');
    assert.equal(d.durationSeconds, null);
    assert.equal(d.trackCount, null);
    assert.match(formatDiagnostics(d), /caption tracks: never listed/);
    assert.match(formatDiagnostics(d), /video:\s+unknown/);
    assert.ok(issueUrl(d).startsWith('https://github.com/'));
  }
  // 0 tracks is an answer ("YouTube listed none"), not a missing field.
  assert.equal(buildDiagnostics({ trackCount: 0 }).trackCount, 0);
  assert.match(formatDiagnostics(buildDiagnostics({ trackCount: 0 })), /caption tracks: 0 listed/);
});

test('the issue URL names the template and only real field ids', () => {
  const url = new URL(issueUrl(buildDiagnostics(input())));
  assert.equal(url.origin + url.pathname, 'https://github.com/olivervanderlugt/video-summary-extension/issues/new');
  assert.equal(url.searchParams.get('template'), 'video-does-not-work.yml');
  // The ids in .github/ISSUE_TEMPLATE/video-does-not-work.yml. A param that is
  // not one of these is dropped by GitHub without a word.
  const ids = ['template', 'url', 'version', 'message', 'console'];
  for (const [name] of url.searchParams) assert.ok(ids.includes(name), `${name} is not a field id`);
  assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=aircAruvnKk');
  assert.equal(url.searchParams.get('version'), '0.4.0');
  assert.match(url.searchParams.get('message'), /YouTube would not hand over the transcript/);
  assert.match(url.searchParams.get('console'), /Video Summary — diagnostics/);
  // Encoded, not raw: the query survives a copy-paste and a space in a message.
  assert.ok(!issueUrl(buildDiagnostics(input())).includes(' '));
  assert.ok(issueUrl(buildDiagnostics(input())).includes('%3Fv%3DaircAruvnKk'));
});

test('a long diagnostics block still yields a URL under the cap', () => {
  // buildDiagnostics already caps every field, so the real panel cannot reach
  // the limit — issueUrl is asked directly here, because it must hold the cap
  // for whatever it is handed, including a field someone adds later.
  const d = { ...buildDiagnostics(input()), message: 'a b c '.repeat(4000), userAgent: 'y '.repeat(4000) };
  const url = issueUrl(d);
  assert.ok(url.length <= MAX_URL, `${url.length} > ${MAX_URL}`);
  assert.match(new URL(url).searchParams.get('console'), /Copy diagnostics/);
  // The full block is still available to the clipboard, untruncated.
  assert.ok(formatDiagnostics(d).length > MAX_URL);
});

test('the fields are capped, so a real panel error is nowhere near the cap', () => {
  const d = buildDiagnostics({ ...input(), message: 'a b c '.repeat(4000), userAgent: 'y '.repeat(4000) });
  assert.ok(d.message.length <= 600);
  assert.ok(d.userAgent.length <= 300);
  assert.ok(issueUrl(d).length < 2500);
});

test('the cap is honoured even when it is absurdly small', () => {
  const url = issueUrl(buildDiagnostics(input()), 400);
  assert.ok(url.startsWith('https://github.com/'));
  assert.equal(new URL(url).searchParams.get('message'), '');
});
