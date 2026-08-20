# Handoff — the caption token, still unexplained

**Status: blocked on one measurement.** Read this before touching
`ensurePot` in `src/content/inject.js`.

## The mystery, stated exactly

Borrowing the player's proof-of-origin token worked **once**, on
2026-08-20, on `watch?v=aircAruvnKk`, in a live console session. It has not
worked before or since — not in the extension, not on a second attempt in the
same tab.

That one success is the only evidence the whole approach is sound. Everything
built on top of it is currently unverified.

## What was true during the one success

Recorded at the time, so it can be reproduced:

- The video was **playing**: `getPlayerState() === 1`, `currentTime` advancing,
  observed at 9s then 60s.
- Captions were **off** to begin with (`getOption('captions','track')` → `{}`).
- The player had been poked repeatedly for **several minutes** before it worked:
  `loadModule`, `getOption`, `setOption` called by hand across a dozen probes,
  with sleeps between them.
- Six `timedtext` requests fired, all via **XHR**.
- The captured token was **116 characters**; adding it plus `c=WEB` to our own
  request returned **46,010 bytes / 286 events** where the same request without
  it returned 0.

## What is different in the extension's automatic path

Every one of these is a candidate cause, and none has been eliminated:

1. **Elapsed playback.** In the success the video had been running for roughly a
   minute. On a click the video may have been playing for two seconds. The
   player may not request a caption track until it needs one.
2. **Prior warm-up.** The player had already had its captions module loaded and
   its track set several times. A first, cold `loadModule` may behave
   differently.
3. **The restore races the request.** `ensurePot` sets the track back to the
   viewer's original the moment its poll loop ends. If the player's request is
   still pending, restoring may cancel it — and then we never see the token even
   though it was about to be issued.
4. **Captions already on.** Handled in code (the track is cleared first so the
   set is a real change) but never confirmed against a real player.
5. **The token may be video-scoped.** Untested. The cache is per tab.

## The one thing to do first

Run `dev/diagnose.js` — paste it into the console on a failing video, with the
extension loaded and the video **playing**. It reports, in one object: the
player state, whether captions were already on, per-step timings for
`loadModule` → tracklist → `setOption`, whether a token was ever seen and how
many milliseconds it took, and whether that token actually unlocks the caption
fetch.

Paste the output into `REPORTS.md`. It distinguishes all five hypotheses above
in a single run:

| output | means |
|---|---|
| `token seen: NEVER`, tracklist empty | the module never initialised — hypothesis 2 |
| `token seen: NEVER`, tracklist fine | the player is not requesting — hypothesis 1 or 3 |
| token seen after >4000ms | our poll gives up too early — hypothesis 3 |
| `fetchWithToken.bytes: 0` with a token | the token is not valid for this video — hypothesis 5 |
| `captionsAlreadyOn: true` and no token | hypothesis 4 survived the fix |

## Second measurement, 60 seconds

Whether a `pot` is video-scoped or session-scoped. Capture one on video A, then
from the console on video B fetch B's own `baseUrl` with `&fmt=json3&c=WEB&pot=<A's token>`
and record the byte count. Non-zero means session-scoped and the cache is
correct; zero means video-scoped and the cache is a bug on every second video.

## Do not, before that data exists

- Do not start playback automatically to force a token. It is the viewer's video.
- Do not lengthen the poll blindly — if hypothesis 3 is right the fix is to
  restore the track *after* the token arrives, not to wait longer.
- Do not reorder the strategies. `strategyInnertube` reads `ytInitialData` with
  no video-id check and both fallbacks briefly hold the previous video after an
  SPA navigation; a wrong-video summary is the worst outcome this product has.

## If the token approach turns out to be unreliable

The fallbacks are the real safety net and both are known to work when YouTube's
own transcript panel works. Worth knowing: enabling player captions also caused
the transcript panel to populate in testing (0 → 572 segments), so the token
attempt has a useful side effect even when it fails to capture anything.
