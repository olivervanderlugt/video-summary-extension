/**
 * Transcript primitives. Pure data in, pure data out — no DOM, no chrome.*,
 * so this loads identically in the MV3 service worker and under `node --test`.
 *
 * @typedef {{t:number, d:number, text:string}} Cue
 */

/** Delimiter-escape guard. Case-insensitive, tolerant of `< / transcript >`. */
const DELIM_RE = /<\s*\/?\s*transcript\s*>/gi;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
};

/** Single pass so decoded text is never re-decoded. */
function decodeEntities(s) {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** YouTube wraps caption lines for display; that is layout, not content. */
function normalizeWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** `long` continues `short` word-for-word — the ASR rolling-caption pattern. */
function isContinuation(short, long) {
  if (!short || long.length <= short.length) return false;
  return long.startsWith(short) && long[short.length] === ' ';
}

/**
 * YouTube timedtext `fmt=json3` → cues. Never throws: malformed input is [].
 * @param {any} json
 * @returns {Cue[]}
 */
export function parseJson3(json) {
  let doc = json;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { return []; }
  }
  const events = doc && Array.isArray(doc.events) ? doc.events : null;
  if (!events) return [];

  /** @type {Cue[]} */
  const cues = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs)) continue; // formatting/position event
    const raw = ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join('');
    const text = normalizeWhitespace(decodeEntities(raw));
    if (!text) continue;

    const t = Number(ev.tStartMs) / 1000;
    const d = Number(ev.dDurationMs) / 1000;
    const cue = {
      t: Number.isFinite(t) ? t : 0,
      d: Number.isFinite(d) ? d : 0,
      text
    };

    // Auto-generated tracks emit rolling text: each event repeats the previous
    // one as a prefix. Keep the longer, drop the redundant twin.
    const prev = cues[cues.length - 1];
    if (prev) {
      if (isContinuation(prev.text, text)) {
        prev.text = text;
        prev.d = Math.max(prev.d, cue.t + cue.d - prev.t);
        continue;
      }
      if (isContinuation(text, prev.text)) {
        prev.d = Math.max(prev.d, cue.t + cue.d - prev.t);
        continue;
      }
    }
    cues.push(cue);
  }
  return cues;
}

const isAsr = (tr) => tr.kind === 'asr' || /^a\./.test(String(tr.vssId || ''));
const base = (code) => String(code || '').split('-')[0].toLowerCase();

/**
 * Choose a caption track.
 * @param {Array<{baseUrl:string,languageCode:string,kind?:string,name?:{simpleText?:string},vssId?:string}>} tracks
 * @param {{lang?:string}} [prefs]
 */
export function pickTrack(tracks, prefs = {}) {
  const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
  if (!list.length) return null;

  const lang = prefs && prefs.lang ? String(prefs.lang) : '';
  const manual = list.filter((t) => !isAsr(t));
  const auto = list.filter(isAsr);
  const exact = (arr) => arr.find((t) => String(t.languageCode || '').toLowerCase() === lang.toLowerCase());
  const sameBase = (arr) => arr.find((t) => base(t.languageCode) === base(lang));

  const chosen =
    (lang && exact(manual)) ||
    (lang && exact(auto)) ||
    (lang && sameBase(manual)) ||
    manual.find((t) => base(t.languageCode) === 'en') ||
    auto.find((t) => base(t.languageCode) === 'en') ||
    manual[0] ||
    auto[0] ||
    null;

  return chosen ? { ...chosen, isAuto: isAsr(chosen) } : null;
}

/** 62 → '1:02', 3725 → '1:02:05'. */
export function formatTimestamp(seconds) {
  let s = Math.floor(Number(seconds));
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** '1:02:05' → 3725. Inverse of formatTimestamp. NaN-safe → 0. */
export function parseTimestamp(str) {
  const parts = String(str == null ? '' : str).trim().split(':');
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Strip anything that could close (or open) the trust-boundary block. */
export function stripDelimiters(text) {
  // One pass is not enough: deleting a match splices its neighbours together
  // and can form a fresh delimiter. `</<transcript>transcript>` collapses to a
  // working `</transcript>` after a single replace, which is exactly how a
  // crafted caption would close the trust block and start giving instructions.
  // Repeat until the text stops changing.
  let out = String(text ?? '');
  let previous;
  do {
    previous = out;
    out = out.replace(DELIM_RE, '');
  } while (out !== previous);
  return out;
}

/**
 * Cues → the transcript block the model reads. One timestamp marker roughly
 * every `interval` seconds, not one per cue: per-cue markers triple the token
 * count and shred sentences.
 * @param {Cue[]} cues
 * @param {{interval?:number}} [opts]
 */
export function cuesToText(cues, opts = {}) {
  const interval = Number(opts.interval) > 0 ? Number(opts.interval) : 30;
  const list = Array.isArray(cues) ? cues.filter((c) => c && typeof c.text === 'string') : [];
  if (!list.length) return '';

  const lines = [];
  let buf = null;
  let nextMarker = -Infinity;

  for (const cue of list) {
    const text = normalizeWhitespace(stripDelimiters(cue.text));
    if (!text) continue;
    const t = Number.isFinite(cue.t) ? cue.t : 0;
    if (!buf || t >= nextMarker) {
      buf = { t, parts: [] };
      lines.push(buf);
      nextMarker = t + interval;
    }
    buf.parts.push(text);
  }

  return lines
    .map((l) => `[${formatTimestamp(l.t)}] ${l.parts.join(' ')}`)
    .join('\n');
}

/** Crude but consistent across providers; the router only needs a threshold. */
export function estimateTokens(text) {
  return Math.ceil(String(text == null ? '' : text).length / 4);
}
