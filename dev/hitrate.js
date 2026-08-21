// Paste into the console on a watch page, with the extension loaded.
//
// Runs the real transcript path end to end — the same two page messages the
// panel sends — and prints one row saying which strategy won, how many cues it
// got, and how long it took. It never reaches a provider, so it costs nothing
// and can be run on as many videos as you like.
//
// Use it for the ten-video hit-rate run: open ten videos, paste this on each,
// and keep the rows. `vseHitRate.rows` accumulates across SPA navigations in
// the same tab, and `vseHitRate.summary()` prints the tally.
//
// Read-only apart from the transcript panel, which the panel strategy opens and
// closes again exactly as a real run would.
(() => {
  const store = (window.vseHitRate = window.vseHitRate || { rows: [] });

  const call = (type, payload, timeoutMs) =>
    new Promise((resolve) => {
      const reqId = 'hitrate-' + Math.random().toString(36).slice(2);
      const onMessage = (event) => {
        const msg = event.data;
        if (!msg || msg.source !== 'vse-page' || msg.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve({ ok: msg.ok, data: msg.data, error: msg.error });
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ ok: false, error: { code: 'TIMEOUT', message: `no reply in ${timeoutMs}ms` } });
      }, timeoutMs);
      window.addEventListener('message', onMessage);
      window.postMessage(Object.assign({ source: 'vse', reqId, type }, payload), location.origin);
    });

  store.summary = () => {
    const rows = store.rows;
    const won = rows.filter((r) => r.cues > 0);
    const byStrategy = rows.reduce((acc, r) => {
      const key = r.strategy || `FAIL:${r.error && r.error.code}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    console.log(`hit rate: ${won.length}/${rows.length}`, byStrategy);
    console.table(rows);
    return { hit: won.length, of: rows.length, byStrategy };
  };

  return (async () => {
    const startedAt = Date.now();
    const videoId = new URLSearchParams(location.search).get('v');
    const player = document.getElementById('movie_player');
    const row = { videoId, playerState: player && player.getPlayerState && player.getPlayerState() };

    if (!videoId) {
      console.warn('not a watch page');
      return row;
    }

    const first = await call('transcript', { videoId }, 40000);
    if (!first.ok) {
      Object.assign(row, { stage: 'transcript', error: first.error, ms: Date.now() - startedAt });
    } else {
      const meta = first.data.meta;
      Object.assign(row, {
        title: (meta.title || '').slice(0, 40),
        duration: meta.duration,
        chapters: (meta.chapters || []).length,
        tracks: (first.data.tracks || []).length,
      });

      if (first.data.cues) {
        Object.assign(row, { strategy: first.data.strategy, cues: first.data.cues.length });
      } else {
        const track = (first.data.tracks || [])[0];
        try {
          row.exp = track ? new URL(track.baseUrl).searchParams.getAll('exp').join(',') : '';
        } catch {
          row.exp = '';
        }
        const second = await call(
          'fetchTrack',
          {
            baseUrl: track && track.baseUrl,
            trackInfo: track ? { languageCode: track.languageCode, kind: track.kind } : null,
            videoId,
            duration: meta.duration,
          },
          40000
        );
        if (!second.ok) Object.assign(row, { stage: 'fetchTrack', error: second.error });
        else {
          row.strategy = second.data.strategy;
          row.cues = second.data.json3
            ? (second.data.json3.events || []).length
            : (second.data.cues || []).length;
          // How much of the runtime the transcript actually covers. Anything far
          // below 1 is the number to be suspicious of — a confident summary of
          // the first few minutes is this product's worst failure.
          const last = second.data.cues && second.data.cues[second.data.cues.length - 1];
          if (last && meta.duration) row.coverage = +(last.t / meta.duration).toFixed(2);
        }
      }
      row.ms = Date.now() - startedAt;
    }

    store.rows.push(row);
    console.log(row);
    return row;
  })();
})();
