// The in-product feedback path's data layer. Pure: no DOM, no chrome.*, no
// network, nothing that could send anything anywhere. The extension has no
// telemetry and never will (docs/log/DECISIONS.md); everything here produces
// text that the *user* copies, or a URL the user can read before opening it.
//
// Loaded twice. As a classic content script in the isolated world (see
// manifest.json — content.js is not a module and cannot import), and as an ES
// module by test/diagnostics.test.mjs. `export` is a syntax error in the first
// of those, so the surface hangs on globalThis and the test reads it from there
// after importing the file for its side effect.
//
// THE ALLOWLIST IS THE POINT. buildDiagnostics() names every field it emits and
// copies them one at a time. No spread, no Object.assign, no loop over the
// caller's keys — so a field added to the panel's state later (a key, a
// transcript, a summary) cannot reach a user's clipboard or a GitHub URL by
// default. Someone has to type it into this function, and a reviewer sees that
// line in the diff.

const ISSUE_BASE = 'https://github.com/olivervanderlugt/video-summary-extension/issues/new';
// The template's own filename. A `template=` that does not name a real file, or
// a param that is not one of its field ids, is dropped by GitHub in silence —
// url / version / message / console are the ids in
// .github/ISSUE_TEMPLATE/video-does-not-work.yml.
const ISSUE_TEMPLATE = 'video-does-not-work.yml';
// GitHub truncates very long issue URLs. Well under the ~8k where that starts.
const MAX_URL = 6000;
const TOO_LONG =
  'The diagnostics did not fit in this link. Press "Copy diagnostics" in the panel and paste them here.';

const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);

/** Whole seconds, or null for "we never learned it". 0 is not a duration. */
function seconds(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** A count, or null for "we never got as far as listing them". 0 is a real answer. */
function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// Belt and braces over the allowlist, for the one field whose text we do not
// write ourselves: a provider's own error body can echo the key back at us
// ("Incorrect API key provided: sk-…"), and that body reaches the panel as the
// error message. Anything key-shaped is replaced before it can be copied.
const SECRET = /(?:sk-|AIza)[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9]{24,}/g;
const redact = (s) => s.replace(SECRET, '[redacted]');

/**
 * Field by field, deliberately. Anything not named here does not come out.
 *
 * @param {{version?:string, code?:string, title?:string, message?:string,
 *          videoId?:string, durationSeconds?:number, trackCount?:number|null,
 *          strategy?:string, userAgent?:string, language?:string,
 *          timestamp?:string}} [input]
 */
function buildDiagnostics(input) {
  const i = input || {};
  return {
    version: str(i.version, 32),
    code: str(i.code, 64) || 'UNKNOWN',
    title: redact(str(i.title, 200)),
    message: redact(str(i.message, 600)),
    videoId: str(i.videoId, 32),
    durationSeconds: seconds(i.durationSeconds),
    trackCount: count(i.trackCount),
    strategy: str(i.strategy, 32),
    userAgent: str(i.userAgent, 300),
    language: str(i.language, 32),
    timestamp: str(i.timestamp, 40),
  };
}

const videoUrl = (d) => (d.videoId ? `https://www.youtube.com/watch?v=${d.videoId}` : '');

/** What the panel said, as the issue's "What the panel said" field wants it. */
const panelText = (d) => [d.title, d.message].filter(Boolean).join(' — ') || d.code;

/** The block the Copy button puts on the clipboard. Plain text, no markup. */
function formatDiagnostics(d) {
  return [
    'Video Summary — diagnostics',
    `extension:      ${d.version || 'unknown'}`,
    `error code:     ${d.code}`,
    `panel said:     ${panelText(d)}`,
    `video:          ${videoUrl(d) || 'unknown'}`,
    `duration:       ${d.durationSeconds == null ? 'unknown' : `${d.durationSeconds}s`}`,
    `caption tracks: ${d.trackCount == null ? 'never listed' : `${d.trackCount} listed`}`,
    `strategy:       ${d.strategy || 'none reached'}`,
    `browser:        ${d.userAgent || 'unknown'}`,
    `ui language:    ${d.language || 'unknown'}`,
    `time:           ${d.timestamp || 'unknown'}`,
    '',
    'This block holds no API key, no transcript and no summary text.',
  ].join('\n');
}

/**
 * A `?template=…&field=value` link. Nothing is sent by building it — it is a
 * URL, and the user can read it in the status bar before clicking.
 */
function issueUrl(d, maxLength) {
  const cap = Number(maxLength) > 0 ? Number(maxLength) : MAX_URL;
  const make = (message, diagnostics) => {
    const p = new URLSearchParams({ template: ISSUE_TEMPLATE });
    const v = videoUrl(d);
    if (v) p.set('url', v);
    if (d.version) p.set('version', d.version);
    p.set('message', message);
    p.set('console', diagnostics);
    return `${ISSUE_BASE}?${p}`;
  };

  const full = make(panelText(d), formatDiagnostics(d));
  if (full.length <= cap) return full;

  // Over the cap: the copy button carries the detail instead. Shorten what is
  // left until it fits — an unreadably long message is worth less than a link
  // that survives the trip.
  let message = panelText(d);
  let url = make(message, TOO_LONG);
  while (url.length > cap && message.length) {
    message = message.slice(0, Math.max(0, message.length - 200));
    url = make(message, TOO_LONG);
  }
  return url;
}

globalThis.VSE_DIAG = { buildDiagnostics, formatDiagnostics, issueUrl, MAX_URL };
