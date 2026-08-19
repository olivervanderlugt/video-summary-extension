// Main world. Registered with "world":"MAIN" — classic script, no modules.
//
// The only reason this file exists: the transcript lives behind page JavaScript
// (ytcfg's InnerTube key) and the player element is a page object. Everything
// else — the API key, the summary, the UI — stays out of here on purpose,
// because any script YouTube loads can read this world.
//
// Protocol (see docs/.../design.md "Main world <-> content script"):
//   in   { source:'vse',      reqId, type:'transcript'|'fetchTrack'|'seek', ... }
//   out  { source:'vse-page', reqId, ok, data? , error?:{code,message} }
// Every request gets exactly one response, always. A dropped response hangs the
// panel, so every handler is wrapped and every path posts.
(() => {
  'use strict';
  if (window.__vseInjected) return; // SPA re-injection / double registration
  window.__vseInjected = true;

  const OUT = 'vse-page';
  const PLAYER_TIMEOUT = 10000;
  const TIMEDTEXT_TIMEOUT = 15000;

  const reply = (reqId, data) => window.postMessage({ source: OUT, reqId, ok: true, data }, location.origin);

  const fail = (reqId, code, message) =>
    window.postMessage({ source: OUT, reqId, ok: false, error: { code, message } }, location.origin);

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

  // ---------------------------------------------------------------- ytcfg

  function ytcfgValue(name) {
    const cfg = window.ytcfg;
    if (!cfg) return undefined;
    const fromData = cfg.data_ && cfg.data_[name];
    if (fromData) return fromData;
    try {
      return typeof cfg.get === 'function' ? cfg.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The live player response for `videoId`.
   * InnerTube first: it is correct after any SPA navigation. ytInitialPlayerResponse
   * is only trusted when its own videoDetails still names the video we were asked
   * about — after a client-side route change it describes the previous video, and
   * summarising the previous video under the current one is the worst bug here.
   */
  async function getPlayerResponse(videoId) {
    const key = ytcfgValue('INNERTUBE_API_KEY');
    const context = ytcfgValue('INNERTUBE_CONTEXT');
    if (key && context) {
      try {
        const res = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ context, videoId, contentCheckOk: true, racyCheckOk: true }),
          signal: timeoutSignal(PLAYER_TIMEOUT),
        });
        if (res.ok) {
          const json = await res.json();
          if (json && json.videoDetails) return json;
        }
      } catch {
        // fall through to the stale-but-maybe-usable bootstrap object
      }
    }
    const boot = window.ytInitialPlayerResponse;
    if (boot && boot.videoDetails && boot.videoDetails.videoId === videoId) return boot;
    return null;
  }

  // ------------------------------------------------------------- chapters

  /**
   * markersMap has moved around inside playerOverlays across YouTube revisions
   * (decoratedPlayerBarRenderer > playerBar > multiMarkersPlayerBarRenderer today).
   * A bounded search from playerOverlays survives the next move; chapters are
   * optional anyway, so returning [] is a normal outcome, never an error.
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
        .map((r) => ({
          t: Math.round(Number(r.timeRangeStartMillis || 0) / 1000),
          label: String((r.title && (r.title.simpleText || textFromRuns(r.title))) || '').trim(),
        }))
        .filter((c) => c.label && Number.isFinite(c.t));
    } catch {
      return [];
    }
  }

  const textFromRuns = (t) => (Array.isArray(t && t.runs) ? t.runs.map((r) => r.text || '').join('') : '');

  // ------------------------------------------------------------ handlers

  /**
   * Round 1. Returns the caption track list untouched plus the video meta.
   * Track selection lives in the worker (pickTrack) — this world does not decide
   * and does not parse; it only has the credentials to fetch.
   */
  async function handleTranscript(msg) {
    const videoId = msg.videoId;
    if (!videoId) throw errored('NO_PLAYER', 'No video id was supplied.');

    const player = await getPlayerResponse(videoId);
    if (!player) {
      throw errored('NO_PLAYER', "Couldn't read this video's player data. Reload the page and try again.");
    }

    const d = player.videoDetails || {};
    const status = (player.playabilityStatus && player.playabilityStatus.status) || '';
    const reason = (player.playabilityStatus && (player.playabilityStatus.reason || '')) || '';

    const meta = {
      id: d.videoId || videoId,
      title: d.title || '',
      channel: d.author || '',
      duration: Number(d.lengthSeconds || 0) || 0,
      chapters: extractChapters(player),
      lang: '',
      isAuto: false,
    };

    const tracks =
      (player.captions &&
        player.captions.playerCaptionsTracklistRenderer &&
        player.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];

    if (!Array.isArray(tracks) || tracks.length === 0) {
      if (d.isLive || d.isLiveContent) {
        throw errored('LIVE', 'This is a live stream, and live streams have no finished caption track yet.');
      }
      throw errored(
        'NO_CAPTIONS',
        status && status !== 'OK' && reason
          ? `No caption track is available (${reason}).`
          : 'This video has no caption track.'
      );
    }

    // Only the fields the worker needs to choose; passing the raw objects through
    // keeps pickTrack free to look at anything YouTube adds later.
    return { meta, tracks };
  }

  /** Round 2. Fetch the chosen track. Returns the raw json3 body — parsing is the worker's. */
  async function handleFetchTrack(msg) {
    const baseUrl = msg.baseUrl;
    if (typeof baseUrl !== 'string' || !baseUrl) throw errored('TRACK_EMPTY', 'No caption track URL was supplied.');

    let url;
    try {
      url = new URL(baseUrl, location.origin);
    } catch {
      throw errored('TRACK_EMPTY', 'The caption track URL was unusable.');
    }
    url.searchParams.set('fmt', 'json3');

    let res;
    try {
      res = await fetch(url.toString(), { credentials: 'same-origin', signal: timeoutSignal(TIMEDTEXT_TIMEOUT) });
    } catch {
      throw errored('TRACK_EMPTY', "Couldn't download the caption track. Check your connection and try again.");
    }
    if (!res.ok) throw errored('TRACK_EMPTY', `The caption server refused the track (HTTP ${res.status}).`);

    const raw = await res.text();
    if (!raw.trim()) throw errored('TRACK_EMPTY', 'The caption track downloaded empty.');

    let json3;
    try {
      json3 = JSON.parse(raw);
    } catch {
      throw errored('TRACK_EMPTY', "The caption track wasn't in the expected format.");
    }
    // Not parsing, just refusing to hand the worker something that will look like
    // a crash later: a 200 with no events is a real and unremarkable YouTube reply.
    if (!json3 || !Array.isArray(json3.events) || json3.events.length === 0) {
      throw errored('TRACK_EMPTY', 'The caption track downloaded empty.');
    }

    return {
      json3,
      trackInfo: {
        baseUrl,
        lang: msg.lang || '',
        isAuto: !!msg.isAuto,
        name: msg.name || '',
      },
    };
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

  function errored(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  const HANDLERS = {
    transcript: handleTranscript,
    fetchTrack: handleFetchTrack,
    seek: handleSeek,
  };

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
          fail(msg.reqId, 'INTERNAL', 'The page could not return the result.');
        }
      },
      (err) => fail(msg.reqId, (err && err.code) || 'INTERNAL', (err && err.message) || 'Something went wrong.')
    );
  });
})();
