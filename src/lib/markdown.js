/**
 * Minimal markdown → HTML. No dependency by design, and no DOM: this runs in
 * the service worker and under `node --test` as well as in the content script.
 *
 * The input is model output derived from an untrusted transcript, so EVERY
 * character of text is escaped before any tag is emitted. Supported: `#` to
 * `######` headings, `-`/`*` bullets (one level of nesting), `1.` ordered lists,
 * ``` fenced code blocks, `**bold**`, `*italic*`, `` `code` ``, paragraphs.
 * Everything else is literal.
 *
 * It also renders a live token stream, so it must tolerate a document cut off
 * mid-token: an unterminated `**`, a half-typed heading, a dangling `[1:`.
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline spans. Code is split out first so `**` inside it stays literal. */
function inline(text) {
  return String(text == null ? '' : text)
    .split(/(`[^`\n]+`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    })
    .join('');
}

// `#` renders as h2, not h1: this panel is injected into someone else's page
// and must not open a second top-level heading in it.
// Whitespace after the hashes is required, as CommonMark requires it: without
// it `#1 rule of the club` and `#RustLang was mentioned` become headings, and
// both are things a summary of a real video actually says.
const HEADING = /^(#{1,6})(?:\s+(.*))?$/;
const FENCE = /^\s*(?:```|~~~)/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;

/**
 * @param {string} text markdown, possibly truncated mid-token
 * @returns {string} HTML — every tag in it was emitted here, none came from input
 */
export function renderMarkdown(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  /** @type {string[]} */
  const lists = []; // open list tags, innermost last
  let para = [];
  let inFence = false;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join(' ')}</p>`);
    para = [];
  };
  const closeLists = (depth = 0) => {
    while (lists.length > depth) out.push(`</${lists.pop()}>`);
  };

  for (const line of lines) {
    // Fences first: a blank line inside a code block is part of the code.
    if (FENCE.test(line)) {
      if (inFence) out.push('</code></pre>');
      else {
        flushPara();
        closeLists();
        out.push('<pre><code>');
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(escapeHtml(line));
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeLists();
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      flushPara();
      closeLists();
      const tag = h[1].length <= 2 ? 'h2' : 'h3';
      out.push(`<${tag}>${inline(h[2])}</${tag}>`);
      continue;
    }

    const li = line.match(BULLET) || line.match(ORDERED);
    if (li) {
      flushPara();
      const tag = BULLET.test(line) ? 'ul' : 'ol';
      const want = li[1].length >= 2 ? 2 : 1; // one level of nesting, no more
      closeLists(want);
      if (lists.length === want && lists[want - 1] !== tag) closeLists(want - 1);
      while (lists.length < want) {
        out.push(`<${tag}>`);
        lists.push(tag);
      }
      out.push(`<li>${inline(li[2])}</li>`);
      continue;
    }

    // Lazy continuation: a plain line while a list is open belongs to the item
    // above it. Models wrap long bullets constantly, and without this every
    // wrapped bullet breaks out of the list as a stray paragraph.
    if (lists.length && out.length && out[out.length - 1].endsWith('</li>')) {
      const prev = out[out.length - 1];
      out[out.length - 1] = `${prev.slice(0, -5)} ${inline(line.trim())}</li>`;
      continue;
    }

    closeLists();
    para.push(line.trim());
  }

  // A stream cut off inside a fence still has to close its own tags.
  if (inFence) out.push('</code></pre>');
  flushPara();
  closeLists();
  return out.join('\n');
}

/** `[1:02]` / `[1:02:05]` only — digits, in brackets, nothing else. */
const TS = /\[(\d{1,3}(?::\d{2}){1,2})\]/g;

/**
 * Timestamps → seek buttons. A button, not an anchor: no href to navigate and
 * no inline handler; the content script attaches one delegated listener.
 * @param {string} html output of renderMarkdown
 */
export function linkifyTimestamps(html) {
  return String(html == null ? '' : html).replace(TS, (m, ts) => {
    const seconds = ts.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
    return Number.isFinite(seconds)
      ? `<button class="vse-ts" data-t="${seconds}">${ts}</button>`
      : m;
  });
}
