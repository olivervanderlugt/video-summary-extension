# Bug reports

One entry per report. Keep the diagnosis even when the fix is obvious — the
pattern across entries is worth more than any single one.

Template:

```
## YYYY-MM-DD — one-line symptom
reporter / version / browser
video: URL (or n/a)
state: playing or paused, captions on or off, language
panel said: exact text
diagnosis: what was actually wrong
fix: commit, or why not fixed
```

---

## 2026-08-20 — no Summarize button on the watch page
0.1.0 · Chrome · n/a

**Diagnosis:** the YouTube tab was open before the extension was loaded. Chrome
only injects content scripts into pages loaded after install.
**Fix:** none needed. Documented in the README and CONTRIBUTING.

## 2026-08-20 — "YouTube would not hand over the transcript"
0.1.0 · Chrome · real video, healthy profile

**Diagnosis:** the caption endpoint requires a proof-of-origin token. Every
request without one returns 200 with an empty body. Not a code defect — a
YouTube restriction the code did not know about.
**Fix:** `inject.js` borrows the player's token. Commit "fix: get caption text
out of YouTube again".

## 2026-08-20 — stuck on "Reading transcript…" forever
0.2.0 · Chrome

**Diagnosis:** two causes. Wrapping `window.fetch` broke YouTube's own requests,
so every strategy waited out its timeout; and the budgets stacked to ~80s behind
a single frozen label.
**Fix:** XHR-only patch, budgets cut to 8s/4s/6s, per-phase status, fast fail on
a paused player. 0.2.1 and 0.3.0.

## 2026-08-20 — transcript still refused on a playing video
0.3.0 · Chrome · fix shipped, unconfirmed

**Diagnosis:** three defects in the token capture, all found by reading rather
than by the reporter's data.
1. `loadModule('captions')` does not complete synchronously. The code read the
   tracklist immediately after it and got an empty array, then set a track on a
   module that was not ready — which does nothing. The successful manual probe
   had a 400ms wait that the shipped code never had.
2. A viewer with subtitles already on defeated it entirely: setting the track
   the player is already showing is not a change, so nothing is refetched and no
   token ever appears.
3. `isPaused()` treated every state except PLAYING as paused. State 3 is
   BUFFERING — the viewer has pressed play and the video is loading. That is the
   moment someone is most likely to press Summarize, and the code skipped the
   capture and told them to press play.

**Fix:** poll for the tracklist, clear the track before setting it so the set is
a real change, and count buffering as playing. Commit "fix: capture the caption
token in the cases that actually occur".
**Unconfirmed:** the automation profile cannot play video, so this is verified by
reading and by unit test, not end to end.

## 2026-08-21 — transcript fails on a video whose panel is sitting right there
0.3.0 · Brave, real signed-in profile · `Eu1kHIztT24` (1h49)
state: not playing, `readyState` 0, captions off
panel said: "YouTube would not hand over the transcript" (`NO_TRANSCRIPT`, 5.4 s)

**Diagnosis:** two defects, both found by measurement rather than by reading,
and both present in the same failure.
1. `strategyPanel` gave the panel element only ~240 ms (two `sleep(120)`s) to
   materialise before `if (!panel) return null`. Measured on a real page, the
   panel appears and populates in ~403 ms — so the strategy gave up before the
   element existed. The panel on this video held 2,064 usable segments.
2. `ensurePot` was called unconditionally before every caption fetch and costs
   ~5 s of polling when it fails (12×80 ms + 40×100 ms). That was spent even on
   tracks that were never pot-gated — `exp=xpe`/`xpv` in the track's `baseUrl`
   says up front whether a token is needed.

Together: five seconds burnt on a token the track did not need, then a panel
scrape abandoned a quarter-second before the panel arrived.

**Fix:** `src/content/inject.js` — wait for the panel long enough for a real
page, and call `ensurePot` only when the track is actually pot-gated. Applied in
a parallel change.
**Confirmed 2026-08-21:** the ten-video re-run after this fix came back 10/10,
nine of them through the panel at a median ~600 ms — including this video, 1032
cues in 1071 ms. See FACTS.md → Transcript hit rate.

## 2026-08-21 — "The provider returned nothing" partway through a long summary
0.3.0 · Brave, real signed-in profile · `BYizgB2FcAQ` (54 min), Detailed
state: not playing, captions off
panel said: "Reading section 2 of 3", then "The provider returned nothing"
(`EMPTY`, "This usually means the model refused the content or the request was
too long")

**Diagnosis:** the answer-length limit counts a reasoning model's thinking
tokens. The section-2 stream ended `finish_reason: length` having emitted not a
single content delta — the model spent the whole `max_completion_tokens` budget
reasoning and never started the answer. Reproducible: three runs failed at the
same point, and a MutationObserver on the panel timed section 1 at ~15 s to
complete and section 2 at ~15 s then error, every time. Corroborated on
`g6MEDOY7tHo` (1h24, single pass), which did produce output and then hit the
same ceiling, surfacing the existing TRUNCATED warning — same cause, other side
of the line. The old `EMPTY` text sent the reporter hunting for a refusal that
never happened and told them to retry, which cannot help.

**Fix:** `src/background/worker.js` and `src/content/content.js` — a stream that
ends truncated *and* produced no content now throws a distinct `NO_BUDGET`
naming the reasoning-budget cause and pointing at the "Maximum answer length"
setting. Default `maxTokens` raised 4000 → 12000; it is a ceiling, not a spend.
Pinned by a test in `test/worker.test.mjs`.
**Carried forward:** the new default only reaches fresh installs — `loadSettings`
merges stored settings over the defaults, so anyone who already saved settings
keeps 4000 until they raise it by hand. Open question in TODO.md.
