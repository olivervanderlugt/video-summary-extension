// Paste this into the console on a failing YouTube video, with the extension
// loaded and the video PLAYING. Read-only: it touches no key and changes no
// setting. It answers, in one go, every question the handoff is blocked on.
//
// Copy the whole output into docs/log/REPORTS.md.
(async () => {
  const out = { url: location.href, at: new Date().toISOString() };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- what state is the player actually in ---
  const mp = document.getElementById('movie_player');
  const v = document.querySelector('.html5-main-video, video');
  out.player = {
    state: mp?.getPlayerState?.(),          // 1 playing, 2 paused, 3 buffering
    paused: v?.paused,
    t: Math.round(v?.currentTime || 0),
    duration: Number.isFinite(v?.duration) ? Math.round(v.duration) : 'NaN',
  };

  // --- were captions already on before we touched anything ---
  let track0 = null;
  try { track0 = mp.getOption('captions', 'track'); } catch {}
  out.captionsAlreadyOn = !!(track0 && track0.languageCode);
  out.captionsTrack = track0?.languageCode || null;

  // --- did the extension load, and did it already have a token ---
  out.injectLoaded = !!window.__vseInjected;

  // --- watch for the player's own caption request ---
  let seen = null;
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    try {
      const u = new URL(url, location.origin);
      if (u.pathname.includes('timedtext')) {
        seen = { pot: u.searchParams.get('pot'), c: u.searchParams.get('c'), when: Date.now() };
      }
    } catch {}
    return nativeOpen.apply(this, arguments);
  };

  // --- drive the player exactly as ensurePot does, with timings ---
  const t0 = Date.now();
  const steps = [];
  try { mp.loadModule('captions'); steps.push(['loadModule', Date.now() - t0]); } catch (e) { steps.push(['loadModule threw', String(e.message)]); }

  let list = [];
  for (let i = 0; i < 12 && !list.length; i++) {
    try { list = mp.getOption('captions', 'tracklist') || []; } catch { list = []; }
    if (!list.length) await sleep(80);
  }
  steps.push(['tracklist ready', Date.now() - t0, list.length + ' tracks']);

  if (list.length) {
    const wanted = list.find((t) => t.languageCode === 'en') || list[0];
    try {
      if (track0 && track0.languageCode) mp.setOption('captions', 'track', {});
      mp.setOption('captions', 'track', wanted);
      steps.push(['setOption', Date.now() - t0, wanted.languageCode]);
    } catch (e) { steps.push(['setOption threw', String(e.message)]); }
  }

  for (let i = 0; i < 60 && !seen; i++) await sleep(100);
  steps.push(['token seen', seen ? Date.now() - t0 : 'NEVER']);
  out.steps = steps;
  out.token = seen ? { potLen: (seen.pot || '').length, c: seen.c } : null;
  out.captionTextOnScreen = document.querySelectorAll('.ytp-caption-segment').length;

  // --- does the token actually unlock the captions ---
  if (seen?.pot) {
    const pr = mp.getPlayerResponse();
    const tr = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const t = tr.find((x) => x.languageCode === 'en') || tr[0];
    if (t) {
      const u = new URL(t.baseUrl);
      u.searchParams.set('fmt', 'json3');
      u.searchParams.set('pot', seen.pot);
      u.searchParams.set('c', seen.c);
      const r = await fetch(u.toString());
      const b = await r.text();
      out.fetchWithToken = { status: r.status, bytes: b.length };
    }
  }

  // restore whatever the viewer had
  try { mp.setOption('captions', 'track', track0 || {}); } catch {}
  XMLHttpRequest.prototype.open = nativeOpen;

  console.log(JSON.stringify(out, null, 1));
  return out;
})();
