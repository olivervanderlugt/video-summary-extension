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

## 2026-08-20 — "press play" message shown even when playing
0.3.0 · Chrome · OPEN

**Diagnosis:** unknown. All three strategies failed. Either the token was never
captured (see TODO: captions already on) or `isPaused()` misread the state.
**Fix:** open. Needs the diagnostic in TODO.
