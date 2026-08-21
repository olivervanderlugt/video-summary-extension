# Manual QA checklist

Unit tests cover the pure logic. They say nothing about whether YouTube still
serves a caption track, whether Chrome grants the host permission, or whether
the panel lands in the right column. Run this list against a real browser
before calling a change done.

**Covered by `dev/harness.html` already** — re-run it (`python3 dev/serve.py`)
rather than re-checking these by hand: mounting the button and panel, transcript
parsing into cues, streaming render, timestamp seeking, the Ask thread, mode
selection, the partial-transcript notice, Stop, the summary cache, and clearing
state on SPA navigation. What the harness cannot tell you is whether YouTube
still serves a caption track, whether Chrome grants the host permission, and
whether a real provider request succeeds — everything below is about that.

Load the extension: `chrome://extensions` → Developer mode → Load unpacked →
the repo folder. Re-run this whole list after any change to `manifest.json`,
the service worker, or the content scripts.

## Setup

- [ ] Extension loads with no errors on the `chrome://extensions` card
- [ ] Clicking **Errors** on the card shows nothing (service worker parse errors hide here)
- [ ] Options page opens from the toolbar icon
- [ ] Entering a key and pressing **Test this key** reports success and a model count
- [ ] A deliberately wrong key reports a plain sentence, not a stack trace
- [ ] Switching provider preserves the key you already entered for the other one
- [ ] Reloading the options page shows everything still set
- [ ] The caption language dropdown lists **Automatic — whatever the video offers** first, and the choice survives a page reload

## OpenRouter sign-in

Needs a real OpenRouter account. The **Sign in with OpenRouter** button only
appears while OpenRouter is the selected provider — no other provider should
show it.

- [ ] **Sign in with OpenRouter** opens a popup window on openrouter.ai, not a tab, and not a blank window
- [ ] Approving it closes the popup, reports success, switches the provider to OpenRouter, and fills the key field with an `sk-or-` key
- [ ] **Test this key** then succeeds against that key without you typing anything
- [ ] A summary actually runs on the signed-in key, and the network tab shows the request going to `openrouter.ai`
- [ ] Closing the popup part-way reports "Sign-in cancelled" as a plain sentence, not an error dump, and the button becomes usable again
- [ ] After a cancelled sign-in, reload the options page: provider, keys, model, language and every other setting are exactly as they were before you pressed the button — nothing was written
- [ ] Cancelling while a *different* provider's key is already stored leaves that key and that provider selected
- [ ] With the extension signed in, the key it stored appears in your list at <https://openrouter.ai/keys>, and revoking it there makes the next summary fail with a plain message

## Transcript acquisition — the fragile part

Test at least one video from each row. The panel does not surface which
strategy won — read it off the console log, or check the network tab for an
`api/timedtext` request (strategy `captions`) versus a `get_panel` one (panel
scrape).

- [ ] Video with **manual** captions in your preferred language
- [ ] Video with **auto-generated** captions only
- [ ] Video with **no** captions at all → says so calmly, does not read as a crash
- [ ] Video **longer than 2 hours** → map-reduce path, progress shows "section n of m"
- [ ] **Live** stream → clear message, no hang
- [ ] Age-restricted or members-only video → clear message, no hang
- [ ] Non-English video → picks the right track, summary is in a sensible language
- [ ] Video offering **several caption tracks** (say English plus one other): set the language dropdown to the other one, summarize, and the summary comes back in that language — then set it back to English on the same video and it comes back in English
- [ ] Same video on **Automatic**: it takes the English track if the video has one, and does not error when it does not
- [ ] Pick a language the video does not offer → falls back rather than failing, and the summary is still of the right video
- [ ] A video whose track's `baseUrl` carries **no** `exp=xpe`/`xpv` → the caption fetch succeeds without the ~5s token dance
- [ ] Panel strategy on a **legacy**-DOM video (segments are `ytd-transcript-segment-renderer`) → transcript comes back complete
- [ ] Panel strategy on a **modern**-DOM video (segments are `transcript-segment-view-model`) → transcript comes back complete, and no cue text begins with an accessibility label like "0 seconden"
- [ ] Panel strategy on a **long** video (over 1h30) → every segment is picked up without scrolling the panel; spot-check that the last cue's timestamp is near the runtime
- [ ] Open the transcript panel yourself, then summarize → the same transcript, no duplicate panel, no hang

If the caption fetch returns HTTP 200 with an empty body, that is the
proof-of-origin restriction, not a bug in the parser — confirm the panel falls
through to the next strategy rather than showing an error.

## Navigation

- [ ] Open a video, summarize, then click a recommended video: panel resets, **no stale summary from the previous video is ever visible**
- [ ] Browser back/forward between two videos: same
- [ ] Open a watch page directly by URL (cold load), then via in-page navigation (SPA): the button mounts in both cases
- [ ] Theater mode and fullscreen: no layout breakage, panel still reachable on exit
- [ ] Narrow window (under ~1000px, where YouTube collapses the right column): panel is still usable

## The summary itself

- [ ] Text streams in rather than appearing all at once
- [ ] **Stop** actually stops, and keeps the partial text
- [ ] Every timestamp is clickable and seeks the player to the right moment
- [ ] Clicking a timestamp does not scroll the page or restart the video from 0
- [ ] Claims spot-checked against the video are actually supported by it
- [ ] Switching mode (brief / detailed / bullets / eli5 / quotes) visibly changes the output
- [ ] **Ask** answers a follow-up question about the video
- [ ] Copy button copies readable markdown, not HTML

## Money and consent

- [ ] Nothing is summarized until the button is clicked (with `autoRun` off — the default)
- [ ] Re-opening a video you already summarized shows the cached summary and does **not** spend another request
- [ ] Turning `autoRun` on does summarize on open — and turning it off stops that

## Security spot-checks

- [ ] With the panel open, run `chrome.storage.local.get(console.log)` in the **page** console — it should fail; the page has no extension APIs
- [ ] In the extension's service worker console, confirm the key is only in the request to the provider you chose
- [ ] Network tab on a watch page: the only non-YouTube request is to your provider
- [ ] Find a video whose captions contain HTML-looking text and confirm it renders as visible characters, never as markup
- [ ] Revoke the host permission for a custom base URL: the extension reports it instead of failing silently

## Cleanup

- [ ] **Delete all stored data** in options actually clears the key, and the panel then reports no key configured
