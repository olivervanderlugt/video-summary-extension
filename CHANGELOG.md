# Changelog

## 0.5.1

### Changed
- The TL;DR has a fixed shape rather than a word budget: 1-3 paragraphs, 1-5
  sentences each, and **no sentence longer than 12 words**. One idea per
  sentence, and stapling two thoughts together with "and" or a semicolon to
  duck the count is called out as the same long sentence in disguise. Each
  paragraph gets one job — what it concluded, then how it got there or what it
  costs. Short sentences are what make a summary skimmable, and they leave no
  room to hide a clause that says nothing.

## 0.5.0

### Changed
- **The TL;DR is rewritten to sound like a person.** The old one read as
  machine-written and was genuinely hard to get through. The prompt now demands
  a flat opening sentence under twenty words that says what the video concluded
  rather than what it was about; forbids "the video", "the conversation" and
  "the discussion" as the subject of a sentence, since a real subject forces you
  to name who said what; bans the wrap-up line at the end, the participial
  wind-up at the start, and a list of verbs that carry no information
  ("highlights", "underscores", "explores", "delves", "sheds light on" and the
  rest, in either spelling); and requires varied sentence lengths, because
  uniform ones are the clearest tell. Disagreement now has to be attributed
  instead of flattened into consensus.

### Added
- **The panel remembers which summary style you used.** Picking one in the
  dropdown sets it as the default, so the next video opens the way you left it.
  It is the same setting the options page shows — one preference, not two
  shadowing each other.

### Fixed
- Pressing Summarize the instant a watch page loaded could fail with "YouTube
  would not hand over the transcript". The click on YouTube's transcript button
  landed before YouTube was ready to answer it and did nothing at all — no
  panel, no request, no error. It is clicked once more if no rows arrive and no
  transcript panel is open.

## 0.4.0

### Fixed
- **The transcript panel strategy never worked at all.** Three separate defects,
  each enough on its own. The button search returned the `ytd-button-renderer`
  wrapper rather than the `<button>` inside it — `querySelectorAll` answers in
  document order, so the wrapper was always reached first, and clicking a
  Polymer wrapper does nothing. The segment query asked only for
  `ytd-transcript-segment-renderer`, but YouTube ships two generations of that
  row and serves them per video; on a modern-layout video the query matched
  nothing. And the panel element was given about 240ms to appear when it takes
  roughly 400ms. Measured after the fix: 1,032 rows at full runtime coverage in
  853ms, on a video that had been failing outright.
- **Chapters were always empty.** They are not in the player response — a video
  with fifteen chapters returns a response with no `playerOverlays` key at all.
  They are read from `ytInitialData` now, and only when its own
  `currentVideoEndpoint` names the video we were asked about, so a summary can
  never be given the previous video's section titles.
- A caption fetch that is known in advance to return nothing is no longer sent.
  The `baseUrl` advertises whether it needs a proof-of-origin token (`exp=xpe`
  or `exp=xpv`); without one, that request is 200 with an empty body and eight
  seconds of the user's time.
- A transient network error retries once, like a rate limit already did. It
  previously failed the whole run. A request that passes the 60s header timeout
  is deliberately NOT retried — it may still be running and billed.
- An install carrying the old 4000 answer budget is repaired once on load, so
  the raised ceiling reaches existing users and not only fresh installs. A value
  the user set themselves is left alone.
- A fresh install said its language was "Automatic" while the stored default was
  English, and the panel's fallback summary style disagreed with the settings
  page. Both now match what the UI shows.

### Changed
- **Two transcript strategies, not three.** `POST /youtubei/v1/get_transcript`
  is removed: it answers 400 in every environment tried, including when
  YouTube's own interface issues it. YouTube's transcript panel has moved to
  `get_panel`; rather than chase the endpoint, the panel is driven directly.
- **The panel is tried before the token dance, not after it.** It costs about
  400ms, needs no token and does not care whether the video is playing, while
  making the player mint a token costs about five seconds and often fails. The
  order was the difference between a transcript and an error on a video whose
  panel held 2,064 usable rows.
- The panel scrape no longer scrolls. The panel renders every row at once —
  verified at 43 minutes, 54 minutes and 1h49 — so the scroll loop cost a second
  and a half per run and never had anything to collect. The completeness gate
  that guards against a half-transcript stays.
- Waits are bounded by the clock rather than by a count of sleeps. A tab that is
  not visible has its timers clamped to about a second, which stretched a
  four-second wait to forty in front of the spinner.

### Added
- When a run fails, the panel offers a diagnostics block to copy and a
  pre-filled GitHub issue. Nothing is ever sent automatically — the field list
  is an explicit allowlist, so the key, the transcript and the summary cannot
  reach it.
- `dev/hitrate.js`, pasted into the console, runs the real transcript path with
  no provider call, so measuring the hit rate across many videos costs nothing.
- `docs/store-listing.md` — the Chrome Web Store submission material.

## 0.3.0

### Changed
- The five summary styles now each do one thing. Brief is the TL;DR and nothing
  else. Detailed is a fuller TL;DR with the points folded underneath it, so the
  answer is not pushed off the screen by its own evidence. Bullets is only the
  points. Explain simply is two plain paragraphs — what the video is about, and
  what it concludes — with no bullets and no timestamps.
- Key points and key quotes are selective. The prompt now states what earns a
  bullet (a claim, a number, a conclusion, a concession, a definition) and what
  does not (that a topic came up, that background was given, a transition), and
  says fewer and better beats longer. Quotes are capped at six, with two good
  ones preferred over six adequate ones.
- The prompt bans the vocabulary that makes a summary read as machine-written:
  "explores", "delves into", "unpacks", "sheds light on", "key takeaway",
  "leverage", and describing a video's structure in place of its content.

## 0.2.1

### Fixed
- The panel could sit on "Reading transcript…" indefinitely. Wrapping
  `window.fetch` on YouTube's page broke requests made by YouTube itself, so
  every strategy waited out its full timeout. Only XMLHttpRequest is watched
  now, which is what the player actually uses.
- The caption token is only issued while the video is playing. Asking for it on
  a paused player waited for a request that was never going to be made; it now
  returns at once and the message says to press play and retry.

## 0.2.0

### Fixed
- Caption text could not be retrieved at all on most videos. YouTube's endpoint
  answers 200 with an empty body unless the request carries a proof-of-origin
  token; the extension now borrows one from the player, which holds a valid one.
  This was the cause of "YouTube would not hand over the transcript".
- "Try again" after a transcript failure left the panel waiting forever for a
  reply nothing had requested.
- A stale run's late reply could cancel the run that replaced it, silently
  discarding tokens already paid for.
- Selecting the OpenAI-compatible provider with a blank server address sent the
  key and the transcript to `api.openai.com`.
- Timestamps inside follow-up answers were rendered as buttons but did nothing.
- A provider error arriving mid-stream was read as empty text, so half a summary
  was cached as if complete.
- Scraped captions were described to the model as human-authored, so it stopped
  flagging misheard names on the noisiest transcripts.

### Added
- Sign in with OpenRouter instead of copying an API key.
- Caption language chooser, 27 languages.
- Follow-up questions, five summary styles, a per-video session cache.
