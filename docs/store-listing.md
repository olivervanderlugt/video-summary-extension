# Chrome Web Store listing

Paste-ready copy for the Web Store submission form, plus the review material
Google asks for alongside it. Everything here is verifiable in `README.md`,
`PRIVACY.md`, `manifest.json` or the code — nothing is a forward-looking claim.

Nothing in this file is wired into the build. It is copy, not configuration.

---

## 1. Name

**Decided 2026-08-21: the name stays "Video Summary."** Owner's call, made after
reviewing five alternatives. Do not reopen it as part of a listing edit.

What that costs, recorded so nobody mistakes it for an oversight: "Video Summary"
is the exact generic phrase already saturated in this category, so the listing
will not win a search for it. Everything that distinguishes this extension — that
it uses your own API key, that every timestamp seeks the player, that it collects
nothing — has to be carried by the short description and the icon instead. Both
are written below with that job in mind.

The five alternatives, and the reason each was on the list, are in the repository
history for this file if the decision is ever revisited.

---

## 2. Short description

Limit 132 characters. **129 characters:**

```
AI summaries of YouTube videos, using your own API key. Every timestamp is a link that seeks the player. No account, no tracking.
```

Alternates, if the above needs trimming:

- 120 chars — `Summarize YouTube videos with your own AI API key. Timestamps in the summary are links that seek the player. No account.`
- 115 chars — `Summarize a YouTube video with your own AI API key. Every timestamp in the summary is a link that seeks the player.`

The manifest's own `description` field (81 chars) is separate and already
inside its own 132-character limit; it does not need to match this one, but
keeping them close avoids a reviewer noticing a discrepancy.

---

## 3. Detailed description

```
You need your own AI API key to use this. Read that sentence first, because
everything below depends on it.

This extension adds a Summarize button to YouTube watch pages. It reads the
caption track the video already publishes, sends it to the AI provider you
configured, and streams a structured summary into a panel beside the video.

Every timestamp in that summary is a link. Click it and the player seeks
there. That is the reason to use this instead of pasting a transcript into a
chatbot: a chatbot can tell you the interesting part is somewhere around
eighteen minutes in — this puts you there.

BRING YOUR OWN KEY

There is no account here, no subscription, and no server operated by this
extension. You supply a key from one of:

- OpenRouter — press "Sign in with OpenRouter" on the settings page and it
  mints a key for this extension. The only provider you can set up without
  visiting a developer console.
- Anthropic (Claude)
- OpenAI
- Google Gemini — AI Studio has a free tier at the time of writing, which
  makes it the cheapest way to try this.
- Any OpenAI-compatible server, including local ones: Ollama, LM Studio,
  vLLM. You enter the server's base URL; local servers usually need no key.

You pay your provider directly, per request. This extension adds no markup
and never sees your key or your money.

WHAT IT COSTS

Cost is driven almost entirely by transcript length. A 30-minute video is
roughly 4,500 spoken words — about 6,000 input tokens, plus 1,000-2,000
tokens of summary out. In practice that is a fraction of a cent on a small
model and a few cents on a large one. A three-hour podcast is roughly six
times that, and is chunked into sections first, which costs a little more
again.

Two things keep the bill predictable. "Automatically summarise when I open a
video" is off by default, so nothing is spent without a click. And you can
set a hard spend limit on the key in your provider's console — worth doing.

A summary you have already paid for is not paid for twice. Finished summaries
are kept per video and per style for as long as the browser is running, so
returning to a video, or switching back to a style you already ran, paints
the stored copy and sends no request. That cache is in memory only and is
gone when Chrome restarts.

IN THE PANEL

- Five summary styles, switched from a dropdown in the panel header: Brief
  (the TL;DR alone), Detailed (a fuller TL;DR with key points underneath),
  Bullets (only the points), Explain simply (two plain paragraphs, no
  jargon, no timestamps), and Key quotes (up to six verbatim lines, each
  with a note on why it matters). Each style is a separate request.
- Ask — a box under the summary for follow-up questions about the video.
  Answers cite timestamps, and those seek the player too.
- Copy — puts the summary on the clipboard as plain text.
- Settings for model, default style, maximum answer length, and preferred
  caption language (about two dozen named languages, or "Automatic").

PRIVACY

The extension has no server and collects nothing. No analytics, no crash
reporting, no usage counters, no identifier, no phone-home on install.

The only data that leaves your browser is the video's title, channel,
duration, chapter titles and caption text — sent to the one provider you
configured, when you click the button. Once it reaches that provider it is
governed by that provider's policy, which is worth reading, because it is the
only policy that governs it.

Your key is stored in chrome.storage.local, unencrypted, on this machine
only. It is never written to chrome.storage.sync, so it is never uploaded to
your Google account. It is read only by the background service worker and is
never handed to the YouTube page, so no script running on youtube.com can
read it. Storing it unencrypted is a stated choice: an encryption key kept
beside the ciphertext is decoration, not protection. Mint a key this
extension is the only user of, and put a spend limit on it.

There is a "Delete all stored data" button on the settings page.

LIMITATIONS, STATED UP FRONT

- It needs captions. It reads the track YouTube already serves. Automatic
  captions count, but videos with no track at all cannot be summarised.
  There is no audio transcription in this version.
- Automatic captions mishear names, jargon and acronyms. The summary is
  instructed to flag proper nouns it is unsure of rather than invent a
  spelling, but treat every name in a summary of an auto-captioned video as
  approximate.
- Watch pages only: youtube.com/watch. Not Shorts, not playlists as a unit,
  not embeds, not YouTube Music.
- Sometimes YouTube will not hand over the transcript. Opening the video's
  own transcript panel once, or reloading the page, is usually enough.
- It is a summary. It compresses, and compression loses things. The
  timestamps exist so you can check it.

OPEN SOURCE

MIT licensed. No dependencies, no bundler, no build step — every file that
ships is a file in the repository, so anyone who can read JavaScript can
audit what holds their API key.

https://github.com/olivervanderlugt/video-summary-extension
```

---

## 4. Permission justifications

One field per permission in the dashboard. Each paragraph below is sized for
that field.

**`storage`** — Stores the user's settings and API keys on their own machine.
The extension writes the selected provider, model, caption language, default
summary style, answer-length limit and auto-summarise toggle, plus one API key
per provider, to `chrome.storage.local`. Nothing is written to
`chrome.storage.sync`, so nothing is uploaded to the user's Google account.
Without `storage` the user would have to re-enter their API key on every page
load, and no preference would survive a restart.

**`identity`** — Used solely for the optional "Sign in with OpenRouter" button
on the settings page, which spares the user a trip to a developer console. The
extension calls exactly two APIs: `chrome.identity.getRedirectURL()` for its
own `https://<extension-id>.chromiumapp.org/` callback URL, and
`chrome.identity.launchWebAuthFlow()` to open OpenRouter's authorisation page
in a popup. The exchange is OAuth with PKCE (`src/lib/pkce.js`). The extension
never calls `chrome.identity.getProfileUserInfo` or any other API that would
reveal the user's Chrome profile, Google account or email address, and the
manifest does not request `identity.email`. Without `identity`, users would
have to obtain and paste an OpenRouter key by hand; pasting a key remains fully
supported for every provider.

**`https://api.anthropic.com/*`** — The Anthropic API endpoint. The background
service worker POSTs the summary request here, with the user's own Anthropic
key in the auth header, when Anthropic is the selected provider. It is also the
endpoint hit by the "Test this key" button and the model-list refresh. Without
it, the Anthropic provider cannot send a request at all.

**`https://api.openai.com/*`** — The OpenAI API endpoint, used identically to
the Anthropic one when OpenAI is the selected provider: summary requests, key
test, model list. Without it, the OpenAI provider is non-functional.

**`https://generativelanguage.googleapis.com/*`** — The Google Gemini API
endpoint, used identically when Gemini is the selected provider. Without it,
the Gemini provider is non-functional.

**`https://openrouter.ai/*`** — Serves two purposes. It is the API endpoint for
summary requests when OpenRouter is the selected provider, and it is the host
of the OAuth token exchange at `https://openrouter.ai/api/v1/auth/keys` that
the "Sign in with OpenRouter" flow redeems its one-time code against. Without
it, both the OpenRouter provider and the sign-in button fail.

**Access to `https://www.youtube.com/*`** (declared by the two content scripts,
not as a host permission, but shown to users as site access) — This is where
the product runs. The content scripts add the Summarize button and the summary
panel to a watch page, read the video's title, channel, duration and chapter
titles from the page, obtain its caption track, and seek the player when a
timestamp is clicked. Without access to youtube.com there is no button, no
panel and no transcript, and the extension does nothing at all. The extension
requests no other site access at install time: there is no `<all_urls>`, no
`tabs` and no `webRequest`, so it cannot see the user's other tabs or history.

**`world: "MAIN"` content script (`src/content/inject.js`)** — YouTube's
caption track and its player object are page JavaScript, reachable only from
the page's own execution world. `src/content/inject.js` runs in `MAIN` to call
`document.getElementById('movie_player').getPlayerResponse()` for the list of
caption tracks, fetch the chosen track's text (falling back to reading
YouTube's own transcript panel when YouTube declines the direct fetch), and
call the player's seek method when the user clicks a timestamp. It is a
deliberately minimal file with a fixed three-message protocol
(`transcript` / `fetchTrack` / `seek`) and it holds nothing sensitive: the API
key, the summary and the UI all stay in the isolated world and the service
worker, precisely because any script YouTube loads can read the MAIN world.
Without `world: "MAIN"` the extension cannot obtain a transcript or seek the
player — an isolated-world script sees neither object.

**Optional host permissions `https://*/*`, `http://localhost/*`,
`http://127.0.0.1/*`** — These are optional, are **not** granted at install,
and exist only for the "OpenAI-compatible" provider, which lets a user point
the extension at their own inference server: a local Ollama, LM Studio or vLLM
instance, or a self-hosted OpenAI-compatible endpoint. Because that address is
typed by the user and can be any host, the pattern declared in the manifest has
to be broad; what is actually requested at runtime never is. Nothing is
requested until the user enters a base URL on the settings page, and at that
moment `requestOrigin()` in `src/options/options.js` calls
`chrome.permissions.request({ origins: [<that one origin> + '/*'] })` — a
single origin derived from what the user typed, not the wildcard. The grant is
also released: `releaseOrigin()` in the same file calls
`chrome.permissions.remove()` for the previous origin whenever the user points
the setting somewhere else, so a base URL entered once does not remain a
permitted destination forever, and Chrome's own permissions UI can revoke it at
any time. A user who never selects the OpenAI-compatible provider is never
prompted and no host access beyond the four provider APIs is ever held. The
`localhost` and `127.0.0.1` entries are listed separately because
`https://*/*` does not cover plain-http local servers, which is what a local
model server almost always is.

**Remote code** — None. The extension loads and executes no remote code. There
is no bundler, no CDN, no `eval`, no `new Function`, and no externally hosted
script, font or stylesheet. Every file that runs ships inside the package.

---

## 5. Single purpose

```
Summarize the YouTube video on the current watch page by sending its existing
caption track to an AI provider the user configured with their own API key,
and render the summary with timestamps that seek the video player.
```

(220 characters. If a single line is wanted: "Summarize the YouTube video on
the current watch page using an AI provider the user configured with their own
API key.")

---

## 6. Data usage

### The certifications (all three: yes)

- **I do not sell or transfer user data to third parties, outside of the
  approved use cases.** — Certify. From `PRIVACY.md`: *"No data is sold,
  shared, or transmitted to the extension's authors, because there is no
  channel through which that could happen."*
- **I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.** — Certify. The only outbound request is the summary
  request the user asked for, to the provider the user chose.
- **I do not use or transfer user data to determine creditworthiness or for
  lending purposes.** — Certify. Not applicable in any form.

### The data-type checkboxes

Google's form asks what the extension *handles*, which it defines as collecting
**or transferring off the user's device** — a wider net than "collects". This
extension collects nothing for itself, but it does transmit two categories to a
third party at the user's instruction, so those two are declared. Under-
declaring is a common cause of rejection; declaring these two with a clear
explanation is not.

| Data type | Declare? | Why |
| --- | --- | --- |
| Personally identifiable information | No | None is read or sent. `PRIVACY.md`: *"No video content, audio, or your YouTube account information is read or sent."* |
| Health information | No | — |
| Financial and payment information | No | Billing happens entirely in the user's provider account; the extension never sees it. |
| **Authentication information** | **Yes** | The user's API key is stored in `chrome.storage.local` and transmitted to that provider as the provider's own authentication header. It is transmitted nowhere else and to no one else. |
| Personal communications | No | Follow-up questions the user types are sent to the chosen provider as part of the summary conversation; they are not communications between people, and none are stored. |
| Location | No | Never read. |
| Web history | No | No `tabs`, no `webRequest`, no `<all_urls>`. The extension sees only the watch page it is running on and cannot see other tabs or browsing history. |
| User activity | No | No analytics, no usage counters, no telemetry, no unique identifier, no phone-home on install or update. |
| **Website content** | **Yes** | The caption text, title, channel name, duration and chapter titles of the video are read from the page and sent to the user's chosen AI provider when — and only when — the user clicks Summarize. |

### Explanatory text for the form

```
This extension has no server and no operator with access to user data. It
collects nothing for itself: no analytics, no crash reporting, no usage
counters, no identifier, no phone-home on install or update.

Two categories are transferred off the device, both only to a destination the
user chose and both only at the moment the user clicks Summarize:

1. Website content — the video's title, channel name, duration, chapter titles
   and caption text, plus the user's prompt settings and, for a follow-up
   question, the question and the preceding turns of that conversation.
2. Authentication information — the user's own API key, sent to that same
   provider as its authentication header, and nowhere else.

The destination is one of api.anthropic.com, api.openai.com,
generativelanguage.googleapis.com, openrouter.ai, or a custom OpenAI-compatible
server URL the user entered. There is no intermediary. Once data reaches that
provider it is governed by that provider's privacy and data-retention policy.

Keys and settings are stored in chrome.storage.local on the user's machine
only. Nothing is written to chrome.storage.sync, so nothing is uploaded to the
user's Google account or copied to their other devices. Summaries are not
persisted to disk. The settings page has a "Delete all stored data" button that
clears every key and setting immediately.
```

### Privacy policy URL

Required, because authentication information is declared. Point it at the
canonical `PRIVACY.md`:
`https://github.com/olivervanderlugt/video-summary-extension/blob/main/PRIVACY.md`

---

## 7. Screenshots

Format: 1280×800 PNG (the store also accepts 640×400; use 1280×800 for all of
them and do not mix sizes). Between one and five are allowed; take all five, in
this order — the first is the one shown in search results and does most of the
work.

**Three are already captured**, on a live `youtube.com/watch` page in a signed-in
browser, at 1280x800 — see `docs/screenshots/` and its README:

| file | covers item |
|---|---|
| `01-summary.jpg` | 1, below. Use it first: it is the search-result thumbnail. |
| `02-ask.jpg` | the follow-up question box |
| `03-settings.jpg` | the settings page, sign-in and bring-your-own-key both visible |

`90-error-feedback.jpg` is NOT for the listing — it is the failure state, kept as
evidence that the diagnostics affordance renders.

The old `docs/screenshot.png` has been deleted. It was a capture of
`dev/harness.html`, the offline development harness — an empty black box where
the player should be, "recommendations would be here" down the side — at
1512x797, which matches neither accepted size, showing a "WALKTHROUGH" heading
the current prompt no longer produces. Submitting it would have misrepresented
the product.

1. **The whole point: a finished summary beside a real video.** A real watch
   page, real player with a real frame visible, video title and channel
   readable, the panel open on the right with a completed Detailed summary —
   TL;DR paragraph plus Key points, with several `[m:ss]` timestamp chips
   clearly rendered as clickable. Pick a video whose title makes the summary
   obviously about that video. This is the search-results thumbnail; if a user
   only ever sees one image, it must be this one.

2. **Timestamps seek the player.** Same video, same panel, cursor or a subtle
   highlight on one timestamp chip, and the player scrubber visibly parked at
   that position rather than at zero. Caption overlay text: "Click a timestamp,
   the player jumps there." This is the differentiator and it is invisible in a
   static image unless the scrubber position is deliberately staged.

3. **The settings page — bring your own key.** `src/options/options.html` at
   full width, showing the "Sign in with OpenRouter" button, the "I'd rather
   use my own API key" link, the provider list and the "Test this key" button.
   Use a fake key or blur the field — never capture a real key. This screenshot
   exists to set expectations before install: a user who does not know they
   need a key will one-star the extension.

4. **Five summary styles.** The panel with the style dropdown open, all five
   options visible (Brief, Detailed, Bullets, Explain simply, Key quotes),
   over a summary already rendered behind it.

5. **Ask a follow-up.** The panel with the Ask box open under a finished
   summary, a typed question and an answer containing at least one timestamp
   chip.

Also required by the store, separately from these: a 128×128 store icon
(`assets/icon128.png` already exists at that size) and, optionally, a 440×280
small promo tile — worth producing, as listings without one are excluded from
some store placements.

---

## 8. Pre-submission checklist

Everything below must be true before the zip is uploaded.

**Package**

- [ ] `dev/package.sh` run against a clean tree; it emits
      `video-summary-<version>.zip` containing only `manifest.json`, `src/`,
      the four icon PNGs, `LICENSE` and `PRIVACY.md`.
- [ ] Confirm by `unzip -l` that `dev/`, `test/`, `docs/`, `.github/`,
      `package.json`, `README.md`, `.gitignore` and any `.DS_Store` are absent.
- [ ] `manifest.json` sits at the root of the zip, not inside a folder.
- [ ] The four icon PNGs are present and current for the shipped `icon.svg`
      (they are committed on purpose; regenerate if the SVG changed).

**Manifest and version**

- [ ] `manifest.json` `version` is bumped past anything already uploaded — the
      store rejects a re-upload of an existing version number.
- [ ] `CHANGELOG.md` has an entry for the version being shipped. At the time of
      writing `manifest.json` says `0.4.0` and the newest changelog entry is
      `0.3.0`; close that gap before submitting.
- [ ] `manifest.json` `name` matches the store listing name.
- [ ] `action.default_title` matches the new name.
- [ ] `externally_connectable` is empty (`{"ids": [], "matches": []}`) and does
      nothing; consider removing the key entirely rather than leaving a no-op
      declaration for a reviewer to ask about.

**Copy**

- [ ] Short description is ≤132 characters (the recommended one is 129).
- [ ] Detailed description leads with the API-key requirement.
- [ ] No feature in the listing is absent from the code. Specifically: the
      `Detailed` style produces a TL;DR plus Key points — it does **not**
      produce a chapter-by-chapter walkthrough or a "worth watching?" verdict.
      Those were removed (`docs/log/DECISIONS.md` → "Summary modes each do one
      thing") but `README.md` still describes them, so do not copy that
      sentence into the listing, and fix the README.
- [ ] Category and language set. Free-tier / no in-app payments declared.

**Screenshots**

- [ ] Five new screenshots, all 1280×800, all captured on a live
      `youtube.com/watch` page.
- [x] `docs/screenshot.png` is gone — deleted 2026-08-21 (harness capture, wrong
      dimensions, stale output).
- [ ] No real API key visible in the settings screenshot.
- [ ] No personal account details, email address or profile avatar visible in
      YouTube's header.

**Privacy and data**

- [ ] Privacy policy URL entered and publicly reachable.
- [ ] All three data-use certifications checked.
- [ ] "Authentication information" and "Website content" declared; nothing else.
- [ ] Single purpose statement entered.
- [ ] A justification entered for every permission, including each optional
      host permission.

**Function**

- [ ] `node --test` passes on the exact tree being packaged.
- [ ] `docs/manual-qa.md` walked end to end against the packaged build loaded
      unpacked, on a fresh Chrome profile with no prior storage.
- [ ] Transcript retrieval verified on a spread of real videos, not one. A
      reviewer who hits "YouTube would not hand over the transcript" on their
      first test video will treat the extension as broken. `docs/log/TODO.md`
      still lists the ten-video hit-rate test as outstanding and calls it the
      number that decides whether the extension is launchable — run it and
      record the result before submitting.
- [ ] First-install flow checked: the options page opens by itself, and the
      panel on a watch page says a key is needed rather than erroring.
- [ ] "Delete all stored data" verified to clear keys and settings.
- [ ] The OpenAI-compatible provider verified end to end: entering a base URL
      prompts for exactly that origin, changing it releases the previous grant,
      and declining leaves a readable error rather than a silent failure.

**Account**

- [ ] Developer account fee paid and publisher contact email verified — Google
      blocks publication until both are done.
- [ ] Support/homepage URL set to the GitHub repository.
