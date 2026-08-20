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

**The player only requests a caption track while it is playing.** Measured
2026-08-20, twice. Paused (`getPlayerState() === 2`): no request, ever, however
long you wait. Playing: request fires, token capturable.

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

**youtube.com's CSP blocks loading a localhost script into the page**, so the
dev harness cannot be injected into a real watch page. Test the real path by
pasting code into the console instead.

## Node

`node --test test/` fails on Node 22+ (`MODULE_NOT_FOUND`) — positional args
became glob patterns and `test/` matches the directory. Use bare `node --test`.
