# Measured facts

Things established by running something, not by reasoning. Each one cost time to
find. Do not re-derive them; if you contradict one, re-measure and update it
here with the date and the command.

## YouTube caption text

**The caption endpoint answers 200 with an empty body unless the request carries
both `pot` and `c=WEB`.** Measured 2026-08-20 on `watch?v=aircAruvnKk`:

| request | result |
|---|---|
| `baseUrl&fmt=json3` | 200 / 0 bytes |
| `+ pot` alone | 200 / 0 bytes |
| `+ pot & c=WEB` | 200 / **46,010 bytes, 286 events** |
| other language track, same pot | 200 / 27,626 bytes, 231 events |

`pot` is a ~116-character proof-of-origin token. We cannot mint it. One token
served every track on that video.

**The player will hand over a token without the video ever playing.** Measured
2026-08-21 on `watch?v=aircAruvnKk`, real signed-in Brave, extension path: press
Summarize, `api/timedtext` goes out with a borrowed `pot` and answers 200 /
46,010 bytes, and a real summary with working timestamps renders. Throughout,
`readyState` was 0 and the player state 3 (buffering) — the video never played.

**Earlier and contradicting: the player only requests a caption track while it
is playing.** Measured 2026-08-20, twice. Paused (`getPlayerState() === 2`): no
request, ever, however long you wait. Playing: request fires, token capturable.
Both measurements stand. What separates them has not been measured: state 2 is
not state 3, and the 2026-08-21 run was state 3 the whole time.

**`loadModule('captions')` does not finish synchronously.** Reading the tracklist
straight after it returns an empty array, and `setOption('captions','track', …)`
on a module that is not ready silently does nothing. Poll for the tracklist.

**Setting the track the player is already showing is not a change**, so it never
refetches and no token appears. Clear the track first.

**Player states that will fetch captions: 1 (playing) and 3 (buffering).** Not 2,
5 or -1.

**The player uses XMLHttpRequest for it**, not `fetch`. Verified by intercepting
both — only the XHR hook saw it.

**`POST /youtubei/v1/player` with the page's own ytcfg key is useless.** Returns
200 with `playabilityStatus: UNPLAYABLE` and zero caption tracks. Do not build
on it. `movie_player.getPlayerResponse()` works and stays fresh across SPA
navigation.

**`video.duration` is NaN until metadata loads**, and during a pre-roll ad it is
the ad's duration, not the video's.

**`exp=xpe` or `exp=xpv` in a track's `baseUrl` predicts the `pot`
requirement.** Measured 2026-08-21 on real tracks: a track carrying neither flag
fetches bare, no token needed. Same gate yt-dlp applies (`_video.py`:
`any(e in traverse_obj(qs, ('exp', ...)) for e in ('xpe','xpv'))`). So the token
dance is skippable per track rather than always paid.

## YouTube's own transcript endpoints (2026-08-21)

**`POST /youtubei/v1/get_transcript` is dead.** 400 `FAILED_PRECONDITION` from
curl carrying the page's full INNERTUBE_CONTEXT, visitorData and cookies; 400
from a real browser session; and 400 when YouTube's **own** UI issued it on a
signed-out profile. Cause is bot detection that landed ~2025-12 (LuanRT/YouTube.js
issue #1102, "Now they went 100% block"). Nothing about our request is wrong.

**YouTube's transcript panel now calls `POST /youtubei/v1/get_panel`.** Measured
200 / 453,443 bytes on `g2cQ2kD6lzs`. `get_transcript` is an endpoint YouTube
itself abandoned.

**The transcript panel does not virtualise.** Every segment is in the DOM at
once; no scrolling is needed to read them all:

| video | runtime | segments |
|---|---|---|
| `Eu1kHIztT24` | 1h49 | 2,064 |
| `BYizgB2FcAQ` | 54 min | 1,052 |
| `g2cQ2kD6lzs` | 43 min | 324, last timestamp 42:59 against a 43:05 runtime |

The panel appeared and populated in **403 ms** on `g2cQ2kD6lzs`. Budget for
that, not for 240 ms.

**There are two live generations of transcript segment element, and which one a
video serves varies per video on the same profile in the same session.**

| | element | timestamp | text |
|---|---|---|---|
| legacy | `ytd-transcript-segment-renderer` | `.segment-timestamp` | `.segment-text` |
| modern | `transcript-segment-view-model.ytwTranscriptSegmentViewModelHost` | `div.ytwTranscriptSegmentViewModelTimestamp` | `span.ytAttributedStringHost` |

Modern also carries `div.ytwTranscriptSegmentViewModelTimestampA11yLabel`
("0 seconden"), which must be excluded or it lands in the transcript text.
Measured 2026-08-21: `g2cQ2kD6lzs` served modern (324 modern / 0 legacy),
`Eu1kHIztT24` and `BYizgB2FcAQ` served legacy. Query both, always.

## Transcript hit rate (2026-08-21)

**Ten videos, ten transcripts.** Measured 2026-08-21 in the user's real
signed-in Brave, driving the extension's own page protocol, after the
`inject.js` panel-wait and conditional-`ensurePot` fix. Coverage is the span of
the runtime the cues actually cover.

| video | runtime | strategy | cues | coverage | ms | chapters |
|---|---|---|---|---|---|---|
| `Eu1kHIztT24` | 1h49 | panel | 1032 | 1.00 | 1071 | 15 |
| `7ARBJQn6QkM` | 63 min | panel | 520 | 1.00 | 652 | 22 |
| `g2cQ2kD6lzs` | 43 min | panel | 324 | 1.00 | 390 | 0 |
| `BYizgB2FcAQ` | 54 min | panel | 1052 | 1.00 | 596 | 18 |
| `GOqEl4ADyVk` | 1h51 | panel | 836 | 1.00 | 555 | 20 |
| `oX7OduG1YmI` | 47 min | panel | 374 | 0.99 | 306 | 15 |
| `PHpsdIHpLUE` | 1h49 | panel | 949 | 1.00 | 683 | 27 |
| `g6MEDOY7tHo` | 1h24 | panel | 1464 | 1.00 | 1682 | 22 |
| `aircAruvnKk` | 18 min | captions | 217 | — | 6307 | 12 |
| `dQw4w9WgXcQ` | 3min33 | panel | 24 | 0.95 | 199 | 0 |

**Every one of the ten tracks was `exp=xpe`** — all proof-of-origin gated, none
fetched bare.

Nine of ten resolved through the panel, median about 600 ms. The one `captions`
row cost 6.3 s: the panel strategy missed on that video and it fell through to
the player-token path, which then succeeded — the ordering earning its keep.
Chapters are non-zero on eight of ten; they were zero on every video before
today's fix.

What this sample is and is not: podcast/interview-heavy (eight of ten over 40
minutes), one signed-in profile, one locale, one session. It does not cover
signed-out users, videos with no captions at all, live streams, or
age-restricted videos.

## Provider answer budget (2026-08-21)

**The answer-length limit counts a reasoning model's thinking tokens.** Measured
on `BYizgB2FcAQ` (54 min, Detailed): the section-2 stream ended
`finish_reason: length` with not a single content delta — the entire
`max_completion_tokens` budget went to reasoning and the answer never began.
Reproducible, three runs; a MutationObserver on the panel put section 1 at ~15 s
to complete and section 2 at ~15 s then error, every time. Corroborated on
`g6MEDOY7tHo` (1h24, single pass), which *did* produce output before hitting the
same ceiling and surfaced the existing TRUNCATED warning — same cause, other
side of the line.

Default `maxTokens` is now 12,000, up from 4,000. It is a ceiling, not a spend:
a model that answers in 800 tokens costs the same under either.

## Measured on the core path (2026-08-20)

Cue every 2.5s at 35 chars, so a 3-hour video is 4,320 cues:

| | window 480s | window 1800s |
|---|---|---|
| chunks (sequential calls) | 24 | **7** |
| largest chunk | 6,720 chars | 25,200 chars |

`maxChars` is 60,000, so the window fires first every time — 480 was doing all
the work and nothing in the file justified it.

Marker interval, same transcript: **30s costs 158,859 chars, 15s costs 162,199 —
+2.1%.** The source comment claimed per-cue markers "triple the token count";
measurement puts that out by roughly 14x. At 30s a citation landed a median 15s
and up to 27.5s before the moment it cited.

Pure work is free and not worth optimising: on a 3-hour transcript parseJson3
2.6ms, cuesToText 1.6ms, chunkCues 0.1ms, prompt build 0.1ms, markdown render
0.2-0.4ms behind an 80ms throttle. Every second on this path is spent waiting on
YouTube or a provider.

## Environment

**The claude-in-chrome profile is degraded for YouTube.** Its own transcript
panel returns 400 `FAILED_PRECONDITION` and sometimes never issues the request
at all; `log_event` returns 503. Tabs run `visibilityState: hidden`, so
`setTimeout` clamps to ~1s and `requestAnimationFrame` freezes. Never measure
timing there by polling — use a MutationObserver. A transcript failure observed
on that profile is not evidence about the code.

**The claude-in-chrome automation tab is degraded in a second way (2026-08-21).**
It reports `visibilityState: 'hidden'` permanently, so `setTimeout` clamps to
~1s, *and* its video never loads — `readyState` 0 forever. The transcript path
still works there, but nothing depending on playback or on timing can be
measured in it.

**Playwright's bundled Chromium cannot play YouTube at all** (no proprietary
codecs). `getPlayerState()` never leaves -1 and every pot-dependent path fails
there for reasons unrelated to our code. A fresh signed-out profile also hits a
consent wall whose buttons live inside `ytd-consent-bump-v2-lightbox`'s shadow
root; until it is declined YouTube returns 0 bytes for captions and 400 for the
panel. Both are environment artefacts, not evidence about the extension.

**youtube.com's CSP blocks loading a localhost script into the page**, so the
dev harness cannot be injected into a real watch page. Test the real path by
pasting code into the console instead.

## Node

`node --test test/` fails on Node 22+ (`MODULE_NOT_FOUND`) — positional args
became glob patterns and `test/` matches the directory. Use bare `node --test`.
