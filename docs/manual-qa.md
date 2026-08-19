# Manual QA checklist

Unit tests cover the pure logic. They say nothing about whether YouTube still
serves a caption track, whether Chrome grants the host permission, or whether
the panel lands in the right column. Run this list against a real browser
before calling a change done.

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

## Transcript acquisition — the fragile part

Test at least one video from each row. Note which strategy the panel reports.

- [ ] Video with **manual** captions in your preferred language
- [ ] Video with **auto-generated** captions only
- [ ] Video with **no** captions at all → says so calmly, does not read as a crash
- [ ] Video with **chapters** → the Walkthrough section follows the real chapter titles
- [ ] Video **longer than 2 hours** → map-reduce path, progress shows "section n of m"
- [ ] **Live** stream → clear message, no hang
- [ ] Age-restricted or members-only video → clear message, no hang
- [ ] Non-English video → picks the right track, summary is in a sensible language

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
