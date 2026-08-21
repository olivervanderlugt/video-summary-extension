# Handoff — transcript acquisition as it stands

**Status: not blocked.** The token mystery is resolved. Read this before
touching `ensurePot` or `strategyPanel` in `src/content/inject.js`.

## The mystery is over

Measured 2026-08-21 in the user's real signed-in Brave on macOS: on
`watch?v=aircAruvnKk`, pressing Summarize fetched `api/timedtext` with a
borrowed `pot` and got **200 / 46,010 bytes**, then rendered a real summary with
working timestamps. The video was never playing — `readyState` 0, player state 3
(buffering).

So the capture shipped in "fix: capture the caption token in the cases that
actually occur" reproduces, and the five candidate causes the old handoff listed
no longer need distinguishing. `dev/diagnose.js` has done its job.

## The path, as it now is

Two strategies, not three. `get_transcript` is removed — see DECISIONS.md.

1. **Caption fetch with a borrowed token.** The token is sniffed off the
   player's own XHR at `document_start`. When the player has already issued a
   caption request it costs nothing — `7ARBJQn6QkM` came back in **105 ms** that
   way on 2026-08-20. It is now the second thing tried, not the first, and in
   the 2026-08-21 ten-video run it won only once, on `aircAruvnKk`, taking 6.3 s
   because it ran after the panel had missed. `exp=xpe` or `exp=xpv` in the
   track's `baseUrl` says whether a token is needed at all; a track without
   either fetches bare.
2. **Panel scrape.** YouTube's transcript panel does not virtualise — every
   segment is in the DOM at once (2,064 on a 1h49 video) and it populates in
   ~403 ms. This is a real path, not a consolation prize.

## Verified

- **Hit rate: 10/10 on ten videos.** Measured 2026-08-21 in the real signed-in
  Brave, after the two `inject.js` fixes below. Nine through the panel at a
  median ~600 ms; the tenth (`aircAruvnKk`) missed on the panel, fell through to
  the player-token path and succeeded in 6.3 s. All ten tracks `exp=xpe`.
  Chapters non-zero on eight of ten, zero on all ten before the fix. Sample is
  podcast-heavy, one profile, one locale, one session — full table and its
  limits in FACTS.md → Transcript hit rate.
- End-to-end summary in a real signed-in browser, video never played (above).
- `exp=xpe`/`xpv` predicts the pot requirement, on real tracks, matching yt-dlp's
  own gate.
- `get_transcript` returns 400 `FAILED_PRECONDITION` everywhere, including from
  YouTube's own UI. `get_panel` is what the panel calls now.
- Panel segment counts and the ~403 ms populate time, on three videos.
- Two live DOM generations for transcript segments, varying per video within one
  session on one profile.

## Not verified

- **Anything outside that sample.** Signed-out users, videos with no captions
  at all, live streams and age-restricted videos are untested — none of the ten
  was any of those.
- **Whether a `pot` is video-scoped or session-scoped.** Still the open question.
  The cache is per page lifetime; if tokens are video-scoped it is wrong on every
  second video. Sixty seconds to answer: capture one on video A, then from the
  console on video B fetch B's own `baseUrl` with
  `&fmt=json3&c=WEB&pot=<A's token>` and record the byte count. Non-zero means
  session-scoped and the cache is correct; zero means video-scoped and it is a
  bug.

## Five defects found by measurement, fixed in `inject.js`

Every one was invisible to reading and only showed up against a real page.

1. `findTranscriptButton` returned the `ytd-button-renderer` WRAPPER, not the
   `<button>` inside it — `querySelectorAll` answers in document order, so the
   wrapper is always reached first, and clicking a Polymer wrapper does nothing
   at all. This alone made the panel strategy dead on every video.
2. Only `ytd-transcript-segment-renderer` was queried. Both generations ship and
   which one a video gets varies per video, so a modern-layout video returned
   zero rows.
3. The rows can render in a DIFFERENT engagement panel — one video put its 324
   rows under `target-id="PAmodern_transcript_view"` while the pinned
   `engagement-panel-searchable-transcript` sat empty on the same page and
   matched first. The rows are found by their own tag now, and the owning panel
   is derived from them with `closest()`; the panel whose rows they are had no
   `target-id` attribute at all.
4. `strategyPanel` gave the panel element ~240 ms (two `sleep(120)`s) to
   materialise before `if (!panel) return null`. A real page takes ~403 ms.
5. `ensurePot` ran unconditionally before every caption fetch and costs ~5 s of
   polling when it fails — spent even on tracks that were never pot-gated.
   `exp=xpe`/`xpv` tells us when to skip it, and the panel now runs first.

## Still do not

- Do not start playback automatically to force a token. It is the viewer's
  video, and the 2026-08-21 run shows it is not necessary anyway.
- Do not re-add `get_transcript`. It is dead upstream, not misconfigured here.
- Do not delete either DOM-generation branch in the panel scraper. Both
  generations are live right now.
- Do not reorder the strategies casually. The panel briefly holds the previous
  video's segments after an SPA navigation; a wrong-video summary is the worst
  outcome this product has, so the video-id check stays.

## Environments that cannot answer questions

- **claude-in-chrome automation tab**: `visibilityState: 'hidden'` permanently
  (so `setTimeout` clamps to ~1 s) and its video never loads (`readyState` 0
  forever). The transcript path works there; nothing about playback or timing
  can be measured there.
- **Playwright's bundled Chromium**: no proprietary codecs, so YouTube never
  plays, `getPlayerState()` never leaves -1, and every pot-dependent path fails
  for reasons unrelated to the code. A fresh signed-out profile also hits a
  consent wall inside `ytd-consent-bump-v2-lightbox`'s shadow root; until it is
  declined YouTube returns 0 bytes for captions and 400 for the panel.

A failure observed in either is not evidence about the extension.
