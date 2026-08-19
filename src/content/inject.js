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
// TRANSCRIPT STRATEGIES, tried in order, first one that yields text wins:
//   A "captions"  movie_player.getPlayerResponse() -> captionTracks -> the chosen
//                 track's baseUrl + '&fmt=json3'. Measured caveat: YouTube can
//                 return HTTP 200 with a ZERO-LENGTH body for a track that is
//                 listed and looks fine (proof-of-origin-token restriction). That
//                 is a failure OF THIS STRATEGY, not a fatal error — fall through.
//   B "panel"     Drive YouTube's own transcript UI and read the rendered
//                 segments. Produces cues directly. Restores the panel afterwards.
//   C "innertube" POST /youtubei/v1/get_transcript with the params scraped from
//                 ytInitialData. Measured 400 "Precondition check failed" on one
//                 profile, so it is the last resort, not the first.
//
// NOT USED: POST /youtubei/v1/player. Measured to return 200 with
// playabilityStatus UNPLAYABLE and zero captionTracks — it looks like a working
// answer and is not one.
(() => {
  'use strict';
  if (window.__vseInjected) return; // SPA re-injection / double registration
  window.__vseInjected = true;

  const OUT = 'vse-page';
  const TIMEDTEXT_TIMEOUT = 15000;
  const PANEL_TIMEOUT = 8000;
  const INNERTUBE_TIMEOUT = 10000;

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

  function ytcfgValue(name) {
    const cfg = window.ytcfg;
    if (!cfg) return undefined;
    const fromData = cfg.data_ && cfg.data_[name];
    if (fromData !== undefined && fromData !== null) return fromData;
    try {
      return typeof cfg.get === 'function' ? cfg.get(name) : undefined;
    } catch {
      return undefined;
    }
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

  function extractChapters(player) {
    try {
      const map = findMarkersMap(player.playerOverlays, 0) || findMarkersMap(player.frameworkUpdates, 0);
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

  const PANEL_SELECTOR =
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer';
  // The UI is localised (the profile this was measured on was Dutch: "Transcript
  // tonen"). Matching text is therefore a heuristic; the panel's target-id is the
  // reliable signal, so text matching is only used to find the button that opens it.
  const TRANSCRIPT_WORD = /transcript|transkript|transcrip|字幕|文字起こし|стенограмм|транскрип/i;

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

  function waitForSegments(panel, timeoutMs) {
    const existing = panel.querySelectorAll(SEGMENT_SELECTOR);
    if (existing.length) return Promise.resolve(Array.from(existing));
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
        const found = panel.querySelectorAll(SEGMENT_SELECTOR);
        if (found.length) done(Array.from(found));
      });
      obs.observe(panel, { childList: true, subtree: true });
      const timer = setTimeout(() => done(null), timeoutMs);
    });
  }

  function findTranscriptButton() {
    // The description's own transcript section is the stable home for this button.
    const section = document.querySelector('ytd-video-description-transcript-section-renderer');
    const scopes = section ? [section, document] : [document];
    for (const scope of scopes) {
      const candidates = scope.querySelectorAll('button, ytd-button-renderer, yt-button-shape button, tp-yt-paper-button');
      for (const b of candidates) {
        const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`;
        if (TRANSCRIPT_WORD.test(label)) return b;
      }
    }
    return null;
  }

  /**
   * Opens YouTube's transcript panel, reads it, and puts the UI back the way the
   * user left it. Returns cues or null — never throws into the caller's face.
   */
  async function strategyPanel(runtimeHint) {
    let panel = document.querySelector(PANEL_SELECTOR);
    const wasVisible = panel ? panel.getAttribute('visibility') : null;
    const openedByUs = !panel || (wasVisible || '').indexOf('HIDDEN') !== -1 || wasVisible === null;

    try {
      if (!panel || openedByUs) {
        // The button lives under the collapsed description on most layouts.
        const expand = document.querySelector('#description-inline-expander #expand, tp-yt-paper-button#expand');
        if (expand) {
          try {
            expand.click();
            await sleep(120);
          } catch {
            /* description already open */
          }
        }
        const btn = findTranscriptButton();
        if (btn) {
          btn.click();
          await sleep(120);
        }
        panel = document.querySelector(PANEL_SELECTOR);
      }
      if (!panel) return null;

      let segments = await waitForSegments(panel, PANEL_TIMEOUT);
      if (!segments || !segments.length) return null;

      // YouTube may virtualise this list, rendering only the rows in view. A
      // silently truncated transcript is worse than no transcript: it produces a
      // confident summary of the first minute of a long video. Scroll the list
      // until it stops growing, then refuse the strategy if it still falls short
      // of the video's runtime — the video element knows the duration even when
      // the player response did not.
      // The video element is the better source — it is right even when the
      // player response was unreadable — but `duration` is NaN until metadata
      // loads, so fall back to the runtime the caller already knows.
      const video = document.querySelector('.html5-main-video, video');
      const fromElement = Number(video && video.duration);
      const runtime = Number.isFinite(fromElement) && fromElement > 0 ? fromElement : Number(runtimeHint) || 0;
      const lastT = (list) => parseTimestamp(list[list.length - 1]?.querySelector('.segment-timestamp')?.textContent) || 0;
      const scroller =
        panel.querySelector('#segments-container') ||
        panel.querySelector('ytd-transcript-segment-list-renderer') ||
        panel;

      for (let pass = 0; pass < 6; pass++) {
        if (runtime > 0 && lastT(segments) >= runtime * 0.9) break;
        const before = segments.length;
        try {
          scroller.scrollTop = scroller.scrollHeight;
          segments[segments.length - 1]?.scrollIntoView({ block: 'end' });
        } catch {
          /* not scrollable — then it is not virtualised either */
        }
        await sleep(250);
        segments = panel.querySelectorAll(SEGMENT_SELECTOR);
        if (segments.length <= before) break; // stopped growing: this is all there is
      }

      if (runtime > 0 && lastT(segments) < runtime * 0.75) {
        // Still short. Let the next strategy try rather than shipping a partial
        // transcript dressed up as the whole video.
        return null;
      }

      const rows = [];
      for (const seg of segments) {
        const tsEl = seg.querySelector('.segment-timestamp');
        const txtEl = seg.querySelector('.segment-text');
        const t = parseTimestamp(tsEl && tsEl.textContent);
        const text = ((txtEl && txtEl.textContent) || '').replace(/\s+/g, ' ').trim();
        if (!Number.isFinite(t) || !text) continue;
        rows.push({ t, text });
      }
      if (!rows.length) return null;

      return rows.map((r, i) => ({
        t: r.t,
        d: i + 1 < rows.length ? Math.max(0, rows[i + 1].t - r.t) : 4, // last cue gets a nominal length
        text: r.text,
      }));
    } catch {
      return null;
    } finally {
      // Leave the user's UI as we found it.
      try {
        if (panel && openedByUs) {
          const close = panel.querySelector('#visibility-button button, #dismiss-button button');
          if (close) close.click();
          else if (wasVisible) panel.setAttribute('visibility', wasVisible);
          else panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
        }
      } catch {
        /* restoring is best-effort */
      }
    }
  }

  // -------------------------------------------------- strategy C: innertube

  function scrapeTranscriptParams() {
    try {
      const raw = JSON.stringify(window.ytInitialData || {});
      const m = /"getTranscriptEndpoint":\{"params":"([^"]+)"/.exec(raw);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function collectSegments(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return out;
    if (node.transcriptSegmentRenderer) out.push(node.transcriptSegmentRenderer);
    for (const key of Object.keys(node)) collectSegments(node[key], out, depth + 1);
    return out;
  }

  async function strategyInnertube() {
    try {
      const params = scrapeTranscriptParams();
      const context = ytcfgValue('INNERTUBE_CONTEXT');
      if (!params || !context) return null;

      const clientName = ytcfgValue('INNERTUBE_CONTEXT_CLIENT_NAME');
      const clientVersion =
        ytcfgValue('INNERTUBE_CLIENT_VERSION') || (context.client && context.client.clientVersion) || '';

      const headers = { 'content-type': 'application/json' };
      if (clientName != null) headers['x-youtube-client-name'] = String(clientName);
      if (clientVersion) headers['x-youtube-client-version'] = String(clientVersion);

      const res = await fetch('/youtubei/v1/get_transcript?prettyPrint=false', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ context, params }),
        signal: timeoutSignal(INNERTUBE_TIMEOUT),
      });
      if (!res.ok) return null;

      const json = await res.json();
      const segments = collectSegments(json, [], 0);
      const cues = segments
        .map((s) => ({
          t: Number(s.startMs || 0) / 1000,
          d: Math.max(0, (Number(s.endMs || 0) - Number(s.startMs || 0)) / 1000),
          text: textFromRuns(s.snippet).replace(/\s+/g, ' ').trim(),
        }))
        .filter((c) => Number.isFinite(c.t) && c.text);
      return cues.length ? cues : null;
    } catch {
      return null;
    }
  }

  /** B then C. Returns { cues, strategy } or null. */
  async function fallbackCues(runtimeHint) {
    const panel = await strategyPanel(runtimeHint);
    if (panel) return { cues: panel, strategy: 'panel' };
    const innertube = await strategyInnertube();
    if (innertube) return { cues: innertube, strategy: 'innertube' };
    return null;
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
      chapters: player ? extractChapters(player) : [],
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
    throw errored('NO_CAPTIONS', 'This video has no caption track, so there is no transcript to summarise.');
  }

  /**
   * Round 2. Fetch the track the worker chose. The json3 body is returned
   * UNPARSED — cue parsing belongs to src/lib/transcript.js in the worker.
   * A 200 with an empty body is a measured, real YouTube response; it falls
   * through to the panel/innertube strategies rather than failing the run.
   */
  async function handleFetchTrack(msg) {
    const baseUrl = msg.baseUrl;
    const trackInfo = msg.trackInfo || null;

    let json3 = null;
    if (typeof baseUrl === 'string' && baseUrl) {
      try {
        const url = new URL(baseUrl, location.origin);
        // The track list came from the page, so this URL is page-controlled.
        // Nothing but YouTube's own caption hosts should ever be fetched here,
        // and pinning it now means the day this moves into the isolated world
        // it does not arrive with host permissions behind it.
        if (!/(^|\.)(youtube\.com|googlevideo\.com|youtube-nocookie\.com)$/.test(url.hostname)) {
          throw new Error('caption URL is not a YouTube host');
        }
        url.searchParams.set('fmt', 'json3');
        const res = await fetch(url.toString(), {
          credentials: 'same-origin',
          signal: timeoutSignal(TIMEDTEXT_TIMEOUT),
        });
        if (res.ok) {
          const raw = await res.text();
          if (raw.trim()) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.events) && parsed.events.length) json3 = parsed;
          }
        }
      } catch {
        json3 = null; // network error, non-JSON body, abort — all just mean "strategy A failed"
      }
    }

    if (json3) return { json3, trackInfo, strategy: 'captions' };

    // Same rule as handleTranscript: the fallbacks scrape ungated page state, so
    // they may only run while the player still confirms this video. A navigation
    // during the caption fetch would otherwise hand back the next video's panel.
    if (msg.videoId && !getPlayerResponse(msg.videoId)) {
      throw errored('NO_PLAYER', 'The page moved to another video while the transcript was loading. Try again.');
    }

    const fallback = await fallbackCues(Number(msg.duration) || 0);
    if (fallback) return { cues: fallback.cues, trackInfo, strategy: fallback.strategy };

    // Tracks exist but nothing would serve their text. That is session/profile
    // related, not a property of the video, and the fix is different.
    throw errored(
      'NO_TRANSCRIPT',
      'YouTube listed captions for this video but refused to serve the text. Reload the page, or open the video’s own transcript panel once, then try again.'
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
