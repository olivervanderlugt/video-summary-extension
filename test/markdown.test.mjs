import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, linkifyTimestamps, foldSection } from '../src/lib/markdown.js';

const PAIRED = ['p', 'ul', 'ol', 'li', 'h2', 'h3', 'strong', 'em', 'code', 'button'];

/** Every tag we emit is paired; nothing else may appear at all. */
function assertBalanced(html, label) {
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)];
  const stack = [];
  for (const [raw, name] of tags) {
    assert.ok(PAIRED.includes(name), `unexpected tag <${name}> in ${label}`);
    if (raw[1] === '/') {
      assert.equal(stack.pop(), name, `mismatched ${raw} in ${label}: ${html}`);
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `unclosed tags in ${label}: ${html}`);
}

test('all markup in the input renders as visible text', () => {
  const hostile = '<img src=x onerror="alert(1)"> & <script>alert("xss")</script> "quoted"';
  const html = renderMarkdown(hostile);
  assert.equal(/<img|<script/i.test(html), false); // the words survive as text, the tags do not
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&lt;script&gt;'));
  assertBalanced(html, 'hostile input');
});

test('markup inside headings, bullets and code spans is escaped too', () => {
  const html = renderMarkdown('## <b>head</b>\n- <i>item</i>\n\n`<script>`');
  assert.equal(/<(b|i|script)>/.test(html), false);
  assert.ok(html.includes('<h2>&lt;b&gt;head&lt;/b&gt;</h2>'));
  assert.ok(html.includes('<code>&lt;script&gt;</code>'));
  assertBalanced(html, 'escaped blocks');
});

test('headings, paragraphs and inline spans render', () => {
  const html = renderMarkdown(
    '## Title\n\nSome **bold** and *italic* and `code()` here.\n\n### Sub\n\nAnother paragraph.'
  );
  assert.ok(html.includes('<h2>Title</h2>'));
  assert.ok(html.includes('<h3>Sub</h3>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<code>code()</code>'));
  assert.equal((html.match(/<p>/g) || []).length, 2);
  assertBalanced(html, 'basic doc');
});

test('bullets, one level of nesting, and ordered lists', () => {
  const html = renderMarkdown('- one\n- two\n  - nested\n- three\n\n1. first\n2. second');
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 6);
  assertBalanced(html, 'lists');
});

test('asterisks inside a code span stay literal', () => {
  const html = renderMarkdown('use `a ** b` please');
  assert.equal(html.includes('<strong>'), false);
  assert.ok(html.includes('<code>a ** b</code>'));
});

test('unsupported markdown is literal text', () => {
  const html = renderMarkdown('[a link](http://example.com) and ![img](x) and > quote\n\n| a | b |');
  assert.equal(/<a |<img|<blockquote|<table/.test(html), false);
  assert.ok(html.includes('[a link](http://example.com)'));
  assertBalanced(html, 'unsupported syntax');
});

test('linkifyTimestamps emits buttons, not links', () => {
  const html = linkifyTimestamps('<p>[1:02] a claim and [1:02:05] a later one</p>');
  assert.ok(html.includes('<button class="vse-ts" data-t="62">1:02</button>'));
  assert.ok(html.includes('<button class="vse-ts" data-t="3725">1:02:05</button>'));
  assert.equal(/href|onclick|<a /.test(html), false);
  assertBalanced(html, 'linkified');
});

test('linkifyTimestamps ignores non-timestamps and partial ones', () => {
  const input = '[abc] [1:] [:30] [1:2] [] plain 1:02 text [12:34:56:78]';
  assert.equal(linkifyTimestamps(input).includes('<button'), false);
  assert.equal(linkifyTimestamps('[99:99]').includes('data-t="6039"'), true);
});

test('renders every prefix of a streamed document without corrupting', () => {
  const doc = [
    '## TL;DR',
    '',
    'A **bold** claim with `code` and *emphasis*, plus <b>markup</b> & entities.',
    '',
    '## Key points',
    '',
    '- [0:14] first point',
    '- [1:02] second point',
    '  - [1:30] a nested detail',
    '',
    '### [12:00] A section',
    '',
    '1. ordered',
    '2. items'
  ].join('\n');

  for (let i = 0; i <= doc.length; i++) {
    const prefix = doc.slice(0, i);
    let html;
    assert.doesNotThrow(() => {
      html = linkifyTimestamps(renderMarkdown(prefix));
    }, `threw at prefix length ${i}`);
    assertBalanced(html, `prefix length ${i}`);
    assert.equal(/<(b|script|img)[ >]/i.test(html), false, `leaked markup at prefix ${i}`);
  }
});

test('empty and non-string input render to nothing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
  assert.equal(linkifyTimestamps(null), '');
});

test('a wrapped bullet stays inside its list item', () => {
  // Models wrap long bullets. Before this was handled, the continuation line
  // escaped the <ul> and rendered as a loose paragraph under the list.
  const html = renderMarkdown('- [0:20] Weights decide the pattern; the bias decides how\n  much evidence it needs.\n- [0:32] Next point.');
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.equal((html.match(/<p>/g) || []).length, 0);
  assert.match(html, /much evidence it needs\.<\/li>/);
});

test('a paragraph after a blank line still ends the list', () => {
  const html = renderMarkdown('- one\n- two\n\nA new paragraph.');
  assert.match(html, /<\/ul>/);
  assert.match(html, /<p>A new paragraph\.<\/p>/);
});

test('detailed mode folds its bullets behind a disclosure', () => {
  // The TL;DR is the answer; the points are there to check it against, and
  // should not push the answer off the screen.
  const html = renderMarkdown('## TL;DR\nThe answer.\n\n## Key points\n- [0:04] one');
  const folded = foldSection(html, 'Key points');
  assert.match(folded, /<details class="vse-fold"><summary>Key points<\/summary>/);
  assert.ok(!/<h2>Key points<\/h2>/.test(folded), 'the heading became the summary');
  assert.ok(folded.includes('<h2>TL;DR</h2>'), 'the answer stays unfolded');
});

test('folding tolerates a half-streamed document', () => {
  // It runs on every streamed token, so it must never throw or half-wrap.
  const partial = renderMarkdown('## TL;DR\nThe ans');
  assert.equal(foldSection(partial, 'Key points'), partial, 'nothing to fold yet');
  for (const md of ['## Key points', '## Key points\n', '## Key points\n- [0:0']) {
    assert.doesNotThrow(() => foldSection(renderMarkdown(md), 'Key points'));
  }
});

test('folding cannot introduce markup', () => {
  // It operates on our own rendered output; a heading forged in the transcript
  // is already escaped by the time it gets here.
  const html = renderMarkdown('## Key points\n- <img src=x onerror=alert(1)>');
  const folded = foldSection(html, 'Key points');
  assert.ok(!/<img/.test(folded));
  assert.match(folded, /&lt;img/);
});
