// Main world. Registered with "world":"MAIN" — classic script, no modules.
//
// The only reason this file exists: the transcript lives behind page JavaScript
// and the player element is a page object. The API key, the summary and the UI
// stay out of here on purpose — any script YouTube loads can read this world.
//
// Protocol:
//   in   { source:'vse',      reqId, type:'transcript'|'fetchTrack'|'seek', ... }
//   out  { source:'vse-page', reqId, ok, data?, error?:{code,message} }
// Every request gets exactly one response, always. A dropped response hangs the
// panel forever, so every path posts.
//
// TRANSCRIPT STRATEGIES. Two, and the order between them is decided per track
// rather than fixed — see handleFetchTrack.
//   "captions"  movie_player.getPlayerResponse() -> captionTracks -> the chosen
//               track's baseUrl + '&fmt=json3'. Instant when it works. Measured
//               caveat: YouTube returns HTTP 200 with a ZERO-LENGTH body unless
//               the request carries a proof-of-origin token, and the baseUrl says
//               up front whether it will (see potGated). That is a failure OF
//               THIS STRATEGY, not a fatal error — fall through.
//   "panel"     Drive YouTube's own transcript UI and read the rendered segments.
//               Produces cues directly, needs no token, and does not care whether
//               the video is playing. Restores the panel afterwards.
//
// NOT USED, both measured dead rather than assumed:
//   POST /youtubei/v1/player — 200 with playabilityStatus UNPLAYABLE and zero
//   captionTracks. It looks like a working answer and is not one.
//   POST /youtubei/v1/get_transcript — 400 "Precondition check failed" from every
//   environment tried, including when YouTube's own UI issued it. YouTube's panel
//   moved to /youtubei/v1/get_panel; we drive the panel instead of chasing it.
(() => {
  'use strict';
  if (window.__vseInjected) return; // SPA re-injection / double registration
  window.__vseInjected = true;

  const OUT = 'vse-page';
  const TIMEDTEXT_TIMEOUT = 8000;
  const PANEL_TIMEOUT = 6000;

  const reply = (reqId, data) => window.postMessage({ source: OUT, reqId, ok: true, data }, location.origin);
  const fail = (reqId, code, message) =>
    window.postMessage({ source: OUT, reqId, ok: false, error: { code, message } }, location.origin);

  function errored(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  /** AbortSignal.timeout exists in every Chrome that runs MV3, but never trust one API. */
  function timeoutSignal(ms) {
    try {
      return AbortSignal.timeout(ms);
    } catch {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Resolve with the first truthy value `read()` returns, or null on timeout.
   * A MutationObserver rather than a poll: YouTube tabs that are not visible get
   * their timers clamped to about a second, which turns a tuned poll interval
   * into a wait many times longer than it looks on the page.
   */
  function waitFor(read, timeoutMs) {
    const now = read();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        obs.disconnect();
        resolve(value);
      };
      const obs = new MutationObserver(() => {
        const found = read();
        if (found) done(found);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => done(null), timeoutMs);
    });
  }

  // -------------------------------------------------------- player response

  /**
   * movie_player.getPlayerResponse() is the current one and stays correct across
   * SPA navigation. ytInitialPlayerResponse is only trusted when its own
   * videoDetails still names the video we were asked about — after a client-side
   * route change it describes the previous video, and summarising the previous
   * video under the current one is the worst bug this extension could ship.
   */
  function getPlayerResponse(videoId) {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.getPlayerResponse === 'function') {
        const pr = mp.getPlayerResponse();
        if (pr && pr.videoDetails && (!videoId || pr.videoDetails.videoId === videoId)) return pr;
      }
    } catch {
      /* player not ready yet */
    }
    const boot = window.ytInitialPlayerResponse;
    if (boot && boot.videoDetails && boot.videoDetails.videoId === videoId) return boot;
    return null;
  }

  // ------------------------------------------------------------- chapters

  /**
   * markersMap has moved around inside playerOverlays across YouTube revisions
   * (decoratedPlayerBarRenderer > playerBar > multiMarkersPlayerBarRenderer today).
   * A bounded search survives the next move. Chapters are optional — [] is normal.
   */
  function findMarkersMap(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (Array.isArray(node.markersMap)) return node.markersMap;
    for (const key of Object.keys(node)) {
      const hit = findMarkersMap(node[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  const textFromRuns = (t) =>
    t && Array.isArray(t.runs) ? t.runs.map((r) => (r && r.text) || '').join('') : (t && t.simpleText) || '';

  /**
   * The chapter list is NOT in the player response. Measured 2026-08-21: a video
   * with fifteen chapters returned a player response whose keys are
   * responseContext, playabilityStatus, streamingData, playerAds,
   * playbackTracking, captions, videoDetails, playerConfig, storyboards,
   * microformat, cards, trackingParams — no playerOverlays at all, which is why
   * every summary was built with zero chapters. ytInitialData has them.
   *
   * ytInitialData is page state with no proof of which video it belongs to, and
   * after an SPA route change it still describes the previous one, so it is only
   * read when its own currentVideoEndpoint names the video we were asked about.
   * Chapters from the wrong video would put confident, wrong section titles on a
   * summary.
   */
  function initialDataFor(videoId) {
    const data = window.ytInitialData;
    if (!data || !videoId) return null;
    const seen =
      data.currentVideoEndpoint && data.currentVideoEndpoint.watchEndpoint && data.currentVideoEndpoint.watchEndpoint.videoId;
    return seen === videoId ? data : null;
  }

  function extractChapters(player, videoId) {
    try {
      const fromInitialData = initialDataFor(videoId);
      const map =
        findMarkersMap(player.playerOverlays, 0) ||
        findMarkersMap(player.frameworkUpdates, 0) ||
        (fromInitialData && findMarkersMap(fromInitialData.playerOverlays, 0)) ||
        (fromInitialData && findMarkersMap(fromInitialData.frameworkUpdates, 0));
      if (!map) return [];
      const entry = map.find((m) => m && m.key === 'DESCRIPTION_CHAPTERS');
      const chapters = entry && entry.value && entry.value.chapters;
      if (!Array.isArray(chapters)) return [];
      return chapters
        .map((c) => c && c.chapterRenderer)
        .filter(Boolean)
        .map((r) => ({ t: Math.round(Number(r.timeRangeStartMillis || 0) / 1000), label: textFromRuns(r.title).trim() }))
        .filter((c) => c.label && Number.isFinite(c.t));
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------ strategy B: panel

  // Two transcript panels exist in the wild and a page can carry both: the
  // long-standing "engagement-panel-searchable-transcript" and the newer
  // "PAmodern_transcript_view". This is used only for open/close bookkeeping —
  // the rows are found by their own tag, because the empty one matches first.
  const PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"],' +
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]';
  // Two generations of the same row ship at once, and which one a video gets
  // varies BETWEEN VIDEOS in a single session on a single profile — measured
  // 2026-08-21: one 43-minute video served 324 modern rows and zero legacy ones,
  // while a 54-minute and a 1h49 video on the same profile minutes later served
  // 1,052 and 2,064 legacy rows and zero modern. Querying only the legacy tag
  // (which is what this did) returns nothing at all on a modern-layout video, so
  // both have to be asked for, always.
  const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
  const TIMESTAMP_SELECTOR = '.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp';
  // The modern row carries a SECOND timestamp for screen readers ("0 seconden").
  // It is a sibling of the real one and it must never reach the transcript, so
  // the text is read from the caption span rather than from the row's textContent.
  const TEXT_SELECTOR = '.segment-text, .ytAttributedStringHost';
  const A11Y_SELECTOR = '.ytwTranscriptSegmentViewModelTimestampA11yLabel';
  // The UI is localised (the profile this was measured on was Dutch: "Transcript
  // tonen"). Matching text is therefore a heuristic; the panel's target-id is the
  // reliable signal, so text matching is only used to find the button that opens it.
  // Russian YouTube says "Показать текст видео", not "стенограмма" — the word
  // that was here matched nothing on the real UI. The rest were simply missing.
  //
  // Every entry has to be a phrase that ONLY the transcript button carries: a
  // match here is clicked on the user's behalf. Two were not, and are gone:
  //   النص  alone is just "the text", so "نسخ النص" (copy text) matched — the
  //         verb is now required.
  //   字幕  is "subtitles": it matches the player's own CC button (aria-label
  //         "字幕 (c)"), which every watch page has, in zh AND ja.
  // A missed button just costs us the panel strategy; a wrong click cannot be undone.
  const TRANSCRIPT_WORD =
    // Matched against every button label on the page in order to click one, so
    // it must never match an unrelated control. Ten locales were missing and
    // still paid the panel timeout before falling through.
    /transcri|transkri|transkry|trascri|přepis|átirat|μεταγραφ|ถอดเสียง|текст\s+від|транскрип|текст\s+видео|文字起こし|文字[記记][錄录]|[轉转][錄录]稿|스크립트|chép\s+lời|प्रतिलेख|ट्रांसक्रिप्ट|إظهار\s+النص/i;

  /** "1:23" / "12:34:56" / "-0:05" → seconds.
   *  Deliberate twin of parseTimestamp in src/lib/transcript.js — do NOT "unify"
   *  them: this file is a world:MAIN classic script with no build step so it
   *  cannot import the ESM lib, and it returns NaN (not the lib's 0) so callers
   *  drop an unparseable row instead of inventing a cue at t=0. */
  function parseTimestamp(raw) {
    const s = String(raw || '').trim();
    if (!s) return NaN;
    const neg = s[0] === '-';
    const parts = s.replace(/^-/, '').split(':').map((p) => Number(p.trim()));
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return NaN;
    const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
    return neg ? -secs : secs;
  }

  /**
   * One rendered transcript row -> { t, text }, across both DOM generations.
   * Returns null for a row we cannot read rather than guessing: a cue invented
   * at t=0, or one carrying "12 minutes 4 seconds" as its words, is worse in a
   * summary than a missing line.
   */
  function readSegment(seg) {
    const tsEl = seg.querySelector(TIMESTAMP_SELECTOR);
    const t = parseTimestamp(tsEl && tsEl.textContent);
    if (!Number.isFinite(t)) return null;

    let text = '';
    const txtEl = seg.querySelector(TEXT_SELECTOR);
    if (txtEl) text = txtEl.textContent || '';
    else {
      // Neither class matched — the row markup moved again. Fall back to the
      // row's own text minus the two timestamp elements, which is still right
      // as long as a row holds nothing but a time and a line.
      const clone = seg.cloneNode(true);
      for (const el of clone.querySelectorAll(`${TIMESTAMP_SELECTOR}, ${A11Y_SELECTOR}`)) el.remove();
      text = clone.textContent || '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text ? { t, text } : null;
  }

  function waitForSegments(timeoutMs) {
    return waitFor(() => {
      const found = document.querySelectorAll(SEGMENT_SELECTOR);
      return found.length ? Array.from(found) : null;
    }, timeoutMs);
  }

  function findTranscriptButton() {
    // The description's own transcript section is the stable home for this button.
    const section = document.querySelector('ytd-video-description-transcript-section-renderer');
    const scopes = section ? [section, document] : [document];
    for (const scope of scopes) {
      const candidates = scope.querySelectorAll('button, ytd-button-renderer, yt-button-shape button, tp-yt-paper-button');
      for (const b of candidates) {
        const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`;
        if (!TRANSCRIPT_WORD.test(label)) continue;
        // querySelectorAll answers in document order, so a Polymer wrapper is
        // always reached before the real control it wraps — and the click
        // handler is on the inner <button>, not on <ytd-button-renderer>.
        // Clicking the wrapper silently does nothing, which is exactly how this
        // strategy came back empty on a video whose panel held 2,064 rows.
        return b.tagName === 'BUTTON' ? b : b.querySelector('button') || b;
      }
    }
    return null;
  }

  /**
   * Opens YouTube's transcript panel, reads it, and puts the UI back the way the
   * user left it. Returns cues or null — never throws into the caller's face.
   */
  async function strategyPanel(runtimeHint) {
    // Which panel holds the transcript is not knowable up front: a watch page
    // carries several engagement panels and the transcript arrives in a
    // different one depending on the layout YouTube served. Track whether ANY
    // of them was already open, and identify the real one afterwards from the
    // rows themselves.
    const shown = (p) => p && (p.getAttribute('visibility') || '').indexOf('HIDDEN') === -1;
    const openPanel = () => {
      // Rows already on the page are the strongest signal, and the only one that
      // does not depend on a target-id: measured 2026-08-21, the panel actually
      // holding the rows had NO target-id attribute at all, so matching on the
      // known ids alone would call a transcript the viewer opened themselves
      // "ours" and close it in the finally.
      const seg = document.querySelector(SEGMENT_SELECTOR);
      const owner = seg && seg.closest('ytd-engagement-panel-section-list-renderer');
      if (shown(owner)) return owner;
      return Array.from(document.querySelectorAll(PANEL_SELECTOR)).find(shown) || null;
    };

    let panel = openPanel();
    const wasVisible = panel ? panel.getAttribute('visibility') : null;
    const openedByUs = !panel;
    let expandedByUs = false;

    try {
      if (openedByUs) {
        // The button lives under the collapsed description on most layouts.
        // `is-expanded` is how we know a description the user opened themselves
        // is not ours to close again in the finally.
        const expander = document.querySelector('#description-inline-expander');
        const expand = document.querySelector('#description-inline-expander #expand, tp-yt-paper-button#expand');
        if (expand && !(expander && expander.hasAttribute('is-expanded'))) {
          try {
            expand.click();
            expandedByUs = true;
            // The transcript section renders after the expand, not with it, so
            // wait for the button rather than for a guessed number of
            // milliseconds. 120ms was frequently short and cost the strategy.
            await waitFor(findTranscriptButton, 1500);
          } catch {
            /* description already open */
          }
        }
        const btn = findTranscriptButton();
        if (btn) btn.click();
      }

      // Wait for the ROWS, not for a particular panel. Measured 2026-08-21: on
      // one video the 324 transcript rows rendered inside an engagement panel
      // whose target-id is "PAmodern_transcript_view", while the panel this code
      // used to pin — "engagement-panel-searchable-transcript" — existed on the
      // same page, stayed empty, and matched first. Scoping the query to it
      // found zero rows out of three hundred and twenty four.
      //
      // The rows take roughly 400ms to arrive after the click, which is why this
      // waits rather than reading straight away.
      const segments = await waitForSegments(PANEL_TIMEOUT);
      if (!segments || !segments.length) return null;

      // Now the panel is knowable exactly: it is whichever one the rows are in.
      // Restoration has to act on that one, not on whichever matched first.
      panel = segments[0].closest('ytd-engagement-panel-section-list-renderer') || panel;

      const rows = [];
      for (const seg of segments) {
        const row = readSegment(seg);
        if (row) rows.push(row);
      }
      if (!rows.length) return null;

      // The panel does NOT virtualise: it renders every row at once. Measured
      // 2026-08-21 across three videos — 43min/324 rows, 54min/1,052 rows and
      // 1h49/2,064 rows, each complete to within seconds of its runtime, with
      // no scrolling of any kind. The scroll loop that used to live here cost a
      // second and a half per run and never had anything to collect.
      //
      // The completeness gate stays, because "reads as complete and is not" is
      // this product's worst failure. Neither runtime source can be trusted
      // alone: `video.duration` is NaN until metadata loads and is the AD's
      // length during a pre-roll, while the hint is missing when the player
      // response was unreadable. Whichever is longer is the video.
      const video = document.querySelector('.html5-main-video, video');
      const fromElement = Number(video && video.duration);
      const runtime = Math.max(
        Number.isFinite(fromElement) && fromElement > 0 ? fromElement : 0,
        Number(runtimeHint) || 0
      );
      // Below 0.6 the scrape is short for a reason we cannot see, and a caption
      // fetch may still return the whole thing. Above it we keep the scrape even
      // though speech can stop before the runtime does (outros, music, credits);
      // the worker still warns with PARTIAL_TRANSCRIPT under 0.75, so the
      // 0.6–0.75 band reaches the user labelled rather than silently.
      if (runtime > 0 && rows[rows.length - 1].t < runtime * 0.6) return null;

      return rows.map((r, i) => ({
        t: r.t,
        d: i + 1 < rows.length ? Math.max(0, rows[i + 1].t - r.t) : 4, // last cue gets a nominal length
        text: r.text,
      }));
    } catch {
      return null;
    } finally {
      // Leave the user's UI as we found it — the description we expanded included.
      try {
        if (panel && openedByUs) {
          const close = panel.querySelector('#visibility-button button, #dismiss-button button');
          if (close) close.click();
          else if (wasVisible) panel.setAttribute('visibility', wasVisible);
          else panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
        }
        if (expandedByUs) {
          const collapse = document.querySelector('#description-inline-expander #collapse, tp-yt-paper-button#collapse');
          if (collapse) collapse.click();
        }
      } catch {
        /* restoring is best-effort */
      }
    }
  }

  /** The panel, as cues. Returns { cues, strategy } or null. */
  async function fallbackCues(runtimeHint) {
    const panel = await strategyPanel(runtimeHint);
    return panel ? { cues: panel, strategy: 'panel' } : null;
  }

  // ------------------------------------------------------------- handlers

  /**
   * Round 1. Returns meta plus the raw caption track list so the WORKER can pick
   * the track (it knows the user's language preference). When there are no tracks
   * at all we go straight to the fallback strategies and return cues instead.
   */
  async function handleTranscript(msg) {
    const videoId = msg.videoId;
    if (!videoId) throw errored('NO_PLAYER', 'No video id was supplied.');

    const player = getPlayerResponse(videoId);
    const d = (player && player.videoDetails) || {};
    const meta = {
      id: d.videoId || videoId,
      title: d.title || document.title.replace(/ - YouTube$/, ''),
      channel: d.author || '',
      duration: Number(d.lengthSeconds || 0) || 0,
      chapters: player ? extractChapters(player, videoId) : [],
      lang: '',
      isAuto: false,
    };

    const tracks =
      (player &&
        player.captions &&
        player.captions.playerCaptionsTracklistRenderer &&
        player.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];

    if (Array.isArray(tracks) && tracks.length) {
      return { meta, tracks, strategy: 'captions' };
    }

    // Order matters. The fallback strategies scrape whatever is in the page right
    // now — the transcript panel's DOM, ytInitialData — and neither carries proof
    // of which video it belongs to. After an SPA route change both still hold the
    // PREVIOUS video for a moment. Only the player response is id-checked, so
    // until it confirms we are on the requested video, a fallback result could be
    // the last video's transcript summarised under this video's title.
    if (!player) throw errored('NO_PLAYER', "Couldn't read this video's player data. Reload the page and try again.");

    // No listed tracks. The UI panel sometimes still has a transcript (and it is
    // the same data), so try before declaring the video unsummarisable.
    const fallback = await fallbackCues(meta.duration);
    if (fallback) {
      return { meta, tracks: [], cues: fallback.cues, strategy: fallback.strategy, lang: '', isAuto: true };
    }

    if (d.isLive || d.isLiveContent) {
      throw errored('LIVE', 'This is a live stream, and live streams have no finished caption track yet.');
    }
    throw errored('NO_CAPTIONS', 'This video has no caption track, so there is no transcript to summarize.');
  }

  /**
   * Round 2. Fetch the track the worker chose. The json3 body is returned
   * UNPARSED — cue parsing belongs to src/lib/transcript.js in the worker.
   * A 200 with an empty body is a measured, real YouTube response; it falls
   * through to the panel strategy rather than failing the run.
   */
  // ---------------------------------------------------- proof-of-origin token
  //
  // Measured on live YouTube: the caption endpoint answers 200 with an EMPTY
  // BODY unless the request carries both `pot` (a ~116 character
  // proof-of-origin token) and `c=WEB`. With neither, or with only one of the
  // two, the response is zero bytes. With both:
  //
  //     no pot          -> 200 /      0 bytes
  //     pot alone       -> 200 /      0 bytes
  //     pot + c=WEB     -> 200 / 46,010 bytes, 286 events
  //
  // We cannot mint that token — it comes from YouTube's attestation machinery.
  // The player holds a valid one, because it is the player, and it puts the
  // token in the query string of its own caption request. So we watch for that
  // request and borrow the token. One token works for every track on the video.
  //
  // This cannot be closed off without also breaking YouTube's own subtitles.

  let potParams = null; // { pot, c } once seen

  function rememberPot(rawUrl) {
    try {
      const u = new URL(rawUrl, location.origin);
      if (!u.pathname.includes('timedtext')) return;
      const pot = u.searchParams.get('pot');
      const c = u.searchParams.get('c');
      if (pot && c) potParams = { pot, c };
    } catch {
      /* not a URL we can read; nothing to take from it */
    }
  }

  /**
   * Watch every caption request the page makes. Installed at document_start so
   * a user who already has subtitles switched on gives us a token for free,
   * without the player ever being touched.
   */
  function watchForPot() {
    // XHR only. The player was measured using XMLHttpRequest for its caption
    // request, and wrapping window.fetch as well cost far more than it bought:
    // any YouTube code calling fetch unbound (`const f = window.fetch; f(url)`)
    // lands in the wrapper with `this === undefined`, and applying the native
    // fetch to that throws "Illegal invocation" — breaking YouTube's own
    // requests, not ours. This runs on someone else's page; the smallest patch
    // that works is the only acceptable one.
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        rememberPot(url);
      } catch {
        // Never let our bookkeeping break the page's own request.
      }
      return nativeOpen.apply(this, arguments);
    };
  }

  /**
   * No token yet means subtitles have not been on this session. Ask the player
   * for captions just long enough for it to fetch one, then put its settings
   * back exactly as they were — the user should not find subtitles switched on
   * because they pressed Summarize.
   */
  // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering,
  // 5 cued. Buffering means the viewer already pressed play and the video is
  // loading — it will fetch its caption track as soon as it has frames, so
  // treating it as paused was wrong and skipped the token capture on exactly
  // the moment a user is most likely to press Summarize: just after starting.
  const PLAYING_STATES = new Set([1, 3]);

  function isPaused() {
    try {
      const player = document.getElementById('movie_player');
      if (!player || !player.getPlayerState) return false;
      return !PLAYING_STATES.has(player.getPlayerState());
    } catch {
      return false; // unreadable player: do not use this as a reason to give up
    }
  }

  async function ensurePot(preferredLang) {
    if (potParams) return potParams;
    const player = document.getElementById('movie_player');
    if (!player || typeof player.getOption !== 'function') return null;

    // Measured: the player only requests a caption track while it is running.
    // Genuinely paused, it never issues the request however long we wait, and
    // that wait sits in front of the spinner before the fallbacks even start.
    // We will not start playback ourselves to get a token: it is the viewer's
    // video, not ours.
    if (isPaused()) return null;

    try {
      player.loadModule('captions');
    } catch {
      return null; // captions module unavailable; the fallbacks still apply
    }

    // loadModule does not finish synchronously. Reading the tracklist straight
    // after it returns an empty array, and setting a track on a module that is
    // not ready does nothing at all — which is how this silently failed to
    // capture a token even on a playing video.
    // Bounded by the clock, not by a count of sleeps. A tab that is not visible
    // gets setTimeout clamped to about a second, which turned twelve 80ms waits
    // into twelve SECONDS in front of the spinner — and this is the slow path
    // already.
    let list = [];
    for (const deadline = Date.now() + 1000; !list.length && Date.now() < deadline; ) {
      try {
        list = player.getOption('captions', 'tracklist') || [];
      } catch {
        list = [];
      }
      if (!list.length) await sleep(80);
    }
    if (!list.length) return null;

    let previous = null;
    try {
      previous = player.getOption('captions', 'track');
    } catch {
      /* nothing showing, or unreadable; restoring to {} is then correct */
    }

    const wanted = list.find((t) => t.languageCode === preferredLang) || list[0];
    try {
      // A viewer who already has subtitles on is the case that used to defeat
      // this: setting the track it is already showing is not a change, so the
      // player has no reason to fetch anything and no token ever appears.
      // Clearing first makes the set a real change.
      if (previous && previous.languageCode) player.setOption('captions', 'track', {});
      player.setOption('captions', 'track', wanted);
    } catch {
      return null;
    }

    // Same reason: four seconds of clock, not forty sleeps that a background
    // tab stretches to forty seconds.
    for (const deadline = Date.now() + 4000; !potParams && Date.now() < deadline; ) await sleep(100);

    try {
      player.setOption('captions', 'track', previous || {});
    } catch {
      /* best effort: leaving captions on is worse than an exception here */
    }
    return potParams;
  }

  /**
   * Does this track need a token at all? YouTube says so in the baseUrl: the
   * proof-of-origin requirement is an experiment flagged as `exp=xpe` or
   * `exp=xpv`, and yt-dlp gates on exactly those two. A track without them is
   * served bare, so paying for a token on one is several seconds spent for
   * nothing.
   */
  function potGated(url) {
    const flags = url.searchParams.getAll('exp');
    return flags.some((f) => f === 'xpe' || f === 'xpv');
  }

  /**
   * Strategy "captions". Returns a parsed json3 body or null.
   * `pokePlayer` decides whether we may spend seconds driving the player's
   * caption module to make it mint us a token; without it this only uses a token
   * we already have for free.
   */
  async function fetchCaptions(baseUrl, trackInfo, pokePlayer) {
    if (typeof baseUrl !== 'string' || !baseUrl) return null;
    try {
      const url = new URL(baseUrl, location.origin);
      // The track list came from the page, so this URL is page-controlled.
      // Nothing but YouTube's own caption hosts should ever be fetched here,
      // and pinning it now means the day this moves into the isolated world
      // it does not arrive with host permissions behind it.
      const ownOrigin = url.origin === location.origin;
      if (!ownOrigin && !/(^|\.)(youtube\.com|googlevideo\.com|youtube-nocookie\.com)$/.test(url.hostname)) {
        throw new Error('caption URL is not a YouTube host');
      }
      url.searchParams.set('fmt', 'json3');

      const gated = potGated(url);
      // A cached token is free, so use it whichever way the flag reads. Only the
      // player-poking path is expensive enough to be worth gating.
      let proof = potParams;
      if (!proof && gated && pokePlayer) proof = await ensurePot(trackInfo && trackInfo.languageCode);
      // No token for a gated track means the answer is already known: 200 with
      // nothing in it. Issuing it anyway costs up to TIMEDTEXT_TIMEOUT in front
      // of the spinner, on the path where everything else has ALREADY failed —
      // which is exactly where a user has least patience left.
      if (!proof && gated) return null;
      if (proof) {
        url.searchParams.set('pot', proof.pot);
        url.searchParams.set('c', proof.c);
      }

      const res = await fetch(url.toString(), {
        credentials: 'same-origin',
        signal: timeoutSignal(TIMEDTEXT_TIMEOUT),
      });
      if (!res.ok) return null;
      const raw = await res.text();
      if (!raw.trim()) {
        // 200 with nothing in it is the endpoint telling us the token is no
        // good. Cached, it would be replayed on every retry until the page
        // was reloaded, so every Try again would fail the same way.
        potParams = null;
        return null;
      }
      const parsed = JSON.parse(raw);
      return parsed && Array.isArray(parsed.events) && parsed.events.length ? parsed : null;
    } catch {
      return null; // network error, non-JSON body, abort — all just mean "this strategy failed"
    }
  }

  async function handleFetchTrack(msg) {
    const baseUrl = msg.baseUrl;
    const trackInfo = msg.trackInfo || null;

    // The cheap attempt first: a token sniffed for free at document_start, or a
    // track that never needed one. Measured at ~100ms on a 63-minute video.
    let json3 = await fetchCaptions(baseUrl, trackInfo, false);

    if (json3) return { json3, trackInfo, strategy: 'captions' };


    // Same rule as handleTranscript: the fallbacks scrape ungated page state, so
    // they may only run while the player still confirms this video. A navigation
    // during the caption fetch would otherwise hand back the next video's panel.
    if (msg.videoId && !getPlayerResponse(msg.videoId)) {
      throw errored('NO_PLAYER', 'The page moved to another video while the transcript was loading. Try again.');
    }

    // The panel before the token dance, not after it. The panel is measured at
    // ~400ms and needs no token and no playback; driving the player's caption
    // module costs about five seconds of polling and then often fails anyway.
    // Spending the five seconds first was the difference between a transcript
    // and a NO_TRANSCRIPT on a video whose panel held 2,064 usable rows.
    const fallback = await fallbackCues(Number(msg.duration) || 0);
    if (fallback) return { cues: fallback.cues, trackInfo, strategy: fallback.strategy };

    // Last: make the player mint us a token. Expensive, and only worth it once
    // everything cheaper has missed.
    json3 = await fetchCaptions(baseUrl, trackInfo, true);
    if (json3) return { json3, trackInfo, strategy: 'captions' };

    // Only now. The panel does not read playback state — handleTranscript runs
    // it on a paused video that has no caption tracks at all — so failing before
    // it meant a paused video WITH captions did worse than one without. Once
    // everything has missed, a missing token is the best explanation left and
    // pressing play is the one thing the viewer can do.
    if (!potParams && isPaused()) {
      throw errored(
        'NEEDS_PLAY',
        'YouTube only releases caption text while the video is playing. Press play, give it a second, then hit Summarize again.'
      );
    }

    // Tracks exist but nothing would serve their text. That is session/profile
    // related, not a property of the video, and the fix is different.
    throw errored(
      'NO_TRANSCRIPT',
      'YouTube only releases caption text while the video is playing. Press play, give it a second, then try again — or open the video’s own transcript panel once and retry.'
    );
  }

  /** Seek without stealing playback state: a paused video stays paused. */
  function handleSeek(msg) {
    const video = document.querySelector('.html5-main-video, video');
    if (!video) throw errored('NO_VIDEO', 'No video player on this page.');
    const seconds = Number(msg.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) throw errored('BAD_SEEK', 'Invalid timestamp.');
    const wasPlaying = !video.paused && !video.ended;
    video.currentTime = seconds;
    if (wasPlaying && typeof video.play === 'function') {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    return { seconds };
  }

  watchForPot();

  const HANDLERS = { transcript: handleTranscript, fetchTrack: handleFetchTrack, seek: handleSeek };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'vse' || typeof msg.reqId !== 'string') return;
    const handler = HANDLERS[msg.type];
    if (!handler) return;
    (async () => handler(msg))().then(
      (data) => {
        try {
          reply(msg.reqId, data);
        } catch {
          fail(msg.reqId, 'UNKNOWN', 'The page could not return the result.');
        }
      },
      (err) => fail(msg.reqId, (err && err.code) || 'UNKNOWN', (err && err.message) || 'Something went wrong.')
    );
  });
})();
