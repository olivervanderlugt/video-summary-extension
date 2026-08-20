# Open work

Ranked by what it costs a person pressing the button. Move items to Done with
the commit that closed them, so the reasoning survives.

## Now

- [ ] **The transcript still fails on real videos, and we do not know why.**
      Token capture worked exactly once, in a console session, and has not
      reproduced. **Read `HANDOFF.md` first** — it lists five candidate causes
      and one diagnostic that distinguishes them. Do not change `ensurePot`
      before running `dev/diagnose.js` on a failing video.
- [ ] Confirm whether a `pot` is video-scoped or session-scoped. The code caches
      one per page lifetime; if tokens are video-scoped that cache is wrong on
      the second video.
- [ ] Ten-video hit-rate test on a normal browser profile. This number decides
      whether the extension is launchable.
- [ ] Measure whether a `pot` is video- or session-scoped: capture one on video
      A, fetch B's `baseUrl&c=WEB&pot=<A>` from the console, record the bytes in
      FACTS.md. Decides whether the cache is ever keyed by video id.

## Next

- [ ] No automated coverage of `inject.js` beyond `parseTimestamp` and the
      button regex — the transcript strategies are browser-only.
- [ ] Store listing: real screenshots (the current one is from the dev harness),
      a name better than "Video Summary", a justification for
      `optional_host_permissions`.
- [ ] Feedback path in-product: pre-filled GitHub issue, copy-diagnostics.

## Not doing

See DECISIONS.md → Rejected approaches.
