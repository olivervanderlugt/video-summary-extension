# Changelog

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
