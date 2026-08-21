# Open work

Ranked by what it costs a person pressing the button. Move items to Done with
the commit that closed them, so the reasoning survives.

## Now

- [ ] Confirm whether a `pot` is video-scoped or session-scoped. The code caches
      one per page lifetime; if tokens are video-scoped that cache is wrong on
      the second video. Capture one on video A, fetch B's
      `baseUrl&fmt=json3&c=WEB&pot=<A>` from the console, record the bytes in
      FACTS.md. Non-zero: session-scoped, cache is correct. Zero: video-scoped,
      the cache must be keyed by video id.

## Next

- [ ] No automated coverage of `inject.js` beyond `parseTimestamp` and the
      button regex — the transcript strategies are browser-only.
- [ ] Store listing: real screenshots (the current one is from the dev harness),
      a name better than "Video Summary", a justification for
      `optional_host_permissions`.
- [ ] Feedback path in-product: pre-filled GitHub issue, copy-diagnostics.

## Done

- [x] **Stored settings are migrated, once.** Raising the `maxTokens` default
      4000 → 12000 only ever reached a fresh install: `loadSettings` merges
      stored settings over the defaults, so every existing user kept 4000 and
      kept hitting `NO_BUDGET`. There is now a `settingsVersion` and a narrow
      `migrate()` that raises a stored `maxTokens` of exactly 4000 — our own old
      default, which nobody chose — and writes the result back so it runs once.
      A number the user typed themselves is left alone. The first attempt read
      the version off the MERGED object, where `DEFAULTS` supplies the current
      version and every old install therefore looks already migrated; the test
      caught it, and it reads the version off storage now.

- [x] **Ten-video transcript hit rate: 10/10.** Measured 2026-08-21 in the
      user's real signed-in Brave after the `inject.js` fix — the number that
      decided whether this is launchable. Nine resolved through the panel at a
      median ~600 ms; the tenth fell through to the player-token path and
      succeeded in 6.3 s. All ten tracks were `exp=xpe`. Chapters non-zero on
      eight of ten, having been zero on every video before the fix. Sample is
      podcast-heavy, one profile, one locale, one session — see FACTS.md →
      Transcript hit rate for what it does not cover.
- [x] **Why the transcript failed on real videos.** Resolved 2026-08-21 by
      measurement in a real signed-in browser, not by the five-hypothesis
      diagnostic. Token capture reproduces: `watch?v=aircAruvnKk` fetched
      `api/timedtext` with a borrowed `pot` for 200 / 46,010 bytes and rendered a
      real summary — with the video never playing (`readyState` 0, state 3). The
      shipped capture was correct; two separate defects were starving it. See
      REPORTS.md 2026-08-21.
- [x] **Drop the `get_transcript` strategy.** 400 `FAILED_PRECONDITION` from
      curl with full context, from a real browser session, and from YouTube's own
      UI. YouTube's panel now calls `get_panel` instead. Dead upstream, not
      misconfigured here — DECISIONS.md → Rejected approaches.

## Not doing

See DECISIONS.md → Rejected approaches.
