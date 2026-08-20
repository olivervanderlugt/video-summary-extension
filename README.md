# Video Summary

A Chrome extension that adds a **Summarize** button to YouTube watch pages. It
reads the video's own caption track, sends it to an AI provider you configured
with your own API key, and streams back a structured summary.

The reason to use this instead of pasting a transcript into a chatbot: **every
timestamp in the summary is a link that seeks the player**. A chatbot can tell
you the interesting part is somewhere around eighteen minutes in. This puts you
there.

![The summary panel open beside a video, timestamps rendered as seek buttons](docs/screenshot.png)

<sub>Screenshot from `dev/harness.html` — the offline development harness, not a live YouTube page.</sub>

## Install

There is no store listing and no build step. Clone and load the folder.

```sh
git clone https://github.com/olivervanderlugt/video-summary-extension.git
cd video-summary-extension
```

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `video-summary-extension` folder you just cloned
5. The settings page opens by itself on first install. If it doesn't, click the
   extension's icon in the toolbar.
6. Pick a provider. With OpenRouter you press **Sign in with OpenRouter** and
   authorise it in the popup; with the others you paste an API key. Either way,
   press **Test this key** afterwards.

Your settings are stored locally and persist across browser restarts — you set
the key once. The extension itself has no account and no server, and nothing is
synced anywhere; the only sign-in involved is the optional one to OpenRouter,
which is a sign-in to them, not to this: see [PRIVACY.md](PRIVACY.md). Until a
key is set, the panel says so and offers a link to the settings, rather than
letting you start a summary that can only end in an error.

The rest of the settings page is short: model, summary style, output length, an
auto-summarise toggle that is off by default, a base URL field for the
OpenAI-compatible provider, and **Preferred caption language** — a dropdown with
an "Automatic — whatever the video offers" entry and about two dozen named
languages, set to English on a fresh install. It decides which caption track is
used when a video offers several, and in doing so it usually decides which
language the summary comes back in: the model is given the transcript and told
what language it is in, and answers in kind. Nothing in the prompt hard-forces
that, so it is a strong tendency rather than a guarantee. If the language you
picked is not among the tracks, the extension falls back to English, then to
whatever the video does have; on **Automatic** it goes straight to that
fallback.

If the icons are missing, generate them first — see
[Generating the icons](#generating-the-icons).

## Getting a key

You need an account with one of these. You pay them directly; this extension
never sees a cent and never sees your key.

| Provider | How you get access |
| --- | --- |
| OpenRouter | Press **Sign in with OpenRouter** on the settings page — there is no key to copy. Pasting one from <https://openrouter.ai/keys> also works. |
| Anthropic (Claude) | Paste a key from <https://console.anthropic.com/settings/keys> |
| OpenAI | Paste a key from <https://platform.openai.com/api-keys> |
| Google Gemini | Paste a key from <https://aistudio.google.com/app/apikey> |
| OpenAI-compatible | Whatever your server issues — Ollama, LM Studio, vLLM, Together, and similar. Local servers usually need no key at all; you enter the server's base URL instead. |

OpenRouter is the easiest place to start, because it is the only one you can set
up without visiting a console: you sign in and it mints a key for this
extension. It proxies models from Anthropic, OpenAI and Google, so it is also a
way to reach Claude without holding an Anthropic key — the model it defaults to
here is `anthropic/claude-sonnet-5`. The trade is that OpenRouter is then the
party that receives your transcript and the party that bills you.

Google's AI Studio has a free tier at the time of writing, which makes Gemini
the cheapest way to try this.

### Signing in instead of pasting a key

**Sign in with OpenRouter** opens OpenRouter's authorisation page in a popup
window (`chrome.identity.launchWebAuthFlow`). You approve it there, OpenRouter
sends a one-time code back to the extension's own callback URL, and the
extension trades that code at `https://openrouter.ai/api/v1/auth/keys` for a
key.

The exchange is OAuth with PKCE (`src/lib/pkce.js`): the extension generates a
random verifier, sends only its SHA-256 hash when it opens the popup, and
reveals the verifier when it redeems the code, so a code intercepted on the way
back is useless on its own. There is no client secret and no client
registration — an extension cannot keep a secret, which is the case PKCE exists
for.

The key that comes back is stored **exactly like a pasted one**: same
`chrome.storage.local`, same absence of encryption, same protections and the
same missing ones. Signing in changes how you obtain the key, not where it lives
or how it is guarded — it is more convenient, not more secure. On success the
extension switches the active provider to OpenRouter and puts the key in the
field a pasted key would have gone in. If you close the popup part-way, it
reports "Sign-in cancelled" and writes nothing.

The other providers have no equivalent, and that is not an omission here.
Anthropic prohibits third-party apps from signing users in against their
subscription and issues no client IDs for them, and OpenAI has no authorization
endpoint that mints a key billed to a user's account. For those two, a pasted
API key is the only mechanism they offer.

## What it costs

You are billed by your provider, per request, and this extension adds no markup
of its own. The cost is driven almost entirely by the transcript length. Through
OpenRouter you pay OpenRouter rather than the model's owner, on OpenRouter's
published prices, which are not necessarily what the owner charges directly.

A 30-minute video is roughly 4,500 spoken words, which is about 6,000 input
tokens, plus 1,000–2,000 tokens of summary out. In practice that lands somewhere
between a fraction of a cent on a small, fast model and a few cents on a large
one. A three-hour podcast is roughly six times that, and gets chunked into
sections first, which costs a little more again.

Two things keep the bill boring: "Automatically summarise when I open a video"
is off by default, so nothing is ever spent without a click, and you can set a
hard spend limit on the key in your provider's console.

## Limitations, stated up front

- **It needs captions.** The extension reads the caption track YouTube already
  serves. YouTube's automatic captions count, and most sizeable channels have
  them — but plenty of videos have no track at all, and those cannot be
  summarised. There is no audio transcription in this version.
- **Auto-captions mishear things.** Names, jargon, and acronyms come through
  wrong. The summary is instructed to flag proper nouns it is unsure of rather
  than invent a spelling, but treat every name in a summary of an auto-captioned
  video as approximate.
- **Watch pages only.** `youtube.com/watch`. Not Shorts, not playlists as a
  unit, not embeds, not YouTube Music.
- **Chromium browsers only.** Chrome, Edge, Brave, and other Chromium forks with
  Manifest V3. No Firefox or Safari port.
- **It is a summary.** It compresses, and compression loses things. The
  timestamps exist so you can check it.

## Privacy

The extension has no server and collects nothing. The only data that leaves your
browser is the video's title, channel, duration, chapters, and caption text, sent
to the one AI provider you configured, when you click the button. Your key is
stored locally in `chrome.storage.local` and never syncs to Google.

Full detail in [PRIVACY.md](PRIVACY.md).

## Security

Read this before pasting a key anywhere, including here.

Your API key is stored in `chrome.storage.local`, **unencrypted**. Anyone with
access to your Chrome profile directory can read it, exactly as they could read
the passwords Chrome has saved for you. A key obtained by signing in to
OpenRouter sits in the same place with the same lack of protection — the sign-in
saves you a trip to a console, and buys you nothing else. This extension does not claim to encrypt
it, because encrypting a key while storing the passphrase beside it in the same
extension is theatre, not security.

What the design does do:

- The key is held and used only by the background service worker. It is never
  passed to the content script or to the YouTube page, so no script running on
  youtube.com — YouTube's own or anyone else's — can read it.
- The key is written to `chrome.storage.local`, never `chrome.storage.sync`, so
  it is never uploaded to your Google account.
- The only outbound requests are to the provider you configured, plus the
  OpenRouter sign-in exchange when you press that button. No analytics, no
  telemetry, no remote code, no external fonts or scripts.
- The transcript is passed to the model inside a delimited block with an explicit
  instruction that it is data and not instruction, and the closing delimiter is
  stripped from the transcript first, so a video cannot close the block early and
  address the model directly.
- Model output is rendered by escaping every character; no `innerHTML` ever
  touches model or transcript text.
- Permissions are narrow, and listed in full below. No `<all_urls>` granted at
  install, no `tabs`, no `webRequest`.

### Every permission it asks for

From `manifest.json`, granted at install:

- `storage` — keeps your settings and keys on this machine, in
  `chrome.storage.local` only.
- `identity` — opens the OpenRouter sign-in popup and provides the callback URL
  it returns to. That is its only use: the extension never calls
  `chrome.identity.getProfileUserInfo` or anything else that would read your
  Chrome or Google account.
- `https://api.anthropic.com/*`, `https://api.openai.com/*`,
  `https://generativelanguage.googleapis.com/*`, `https://openrouter.ai/*` — the
  four provider endpoints, so the summary request can be sent to whichever one
  you chose. `openrouter.ai` covers both the sign-in exchange and the summary
  requests.
- `https://www.youtube.com/*` — declared by the two content scripts rather than
  as a host permission, but Chrome shows it as site access all the same. It is
  what lets the extension add the button and panel to a watch page and read the
  caption track.

Optional, and not granted at install:

- `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` — only for the
  OpenAI-compatible provider. Nothing is granted until you enter a base URL, and
  then Chrome is asked for that one origin, not the pattern. Point the setting
  somewhere else and the previous origin's grant is handed back.

The practical advice: mint a key that this extension is the only user of, and
put a spend limit on it. Then the worst case is bounded and one click away from
being revoked.

## Development

No dependencies, no bundler, no transpiler. `package.json` exists only to set
`"type": "module"` and alias the test command — there is nothing to `npm install`,
and there never will be. Every
file that ships is a file in the repository — what you read is what runs. That
is deliberate: it makes the extension auditable by anyone who can read
JavaScript, which matters for something that holds an API key.

Run the tests (Node 18+, no install step):

```sh
node --test test/     # or: npm test
```

They cover the pure logic: caption parsing, track selection, chunk boundaries,
prompt assembly and delimiter stripping, markdown escaping and timestamp
linkification, and each provider's request shape and delta extraction against
recorded SSE fixtures. They say nothing about whether YouTube still serves
captions the same way — for that, load the extension and open a video.

Layout:

```
manifest.json            MV3 manifest, permissions, content script registration
src/content/content.js   Button + panel, drives the port, renders deltas
src/content/inject.js    Main world: transcript fetch and player seek
src/content/panel.css    Panel styling
src/background/worker.js Message router, storage, provider dispatch — the only
                         place the API key exists
src/providers/*.js       One adapter per provider: request shape, delta
                         extraction, error sentences
src/lib/*.js             SSE parsing, transcript handling, chunking, prompts,
                         markdown rendering, PKCE for the OpenRouter sign-in
src/options/*            This settings page
test/                    node --test suites and SSE fixtures
docs/                    Design spec
```

After changing anything, hit the reload arrow on the extension's card in
`chrome://extensions` and reload the YouTube tab. Service worker changes need
the extension reload; content script changes need both.

### Generating the icons

`assets/icon.svg` is the source. Chrome needs PNGs at load time, so the
generated PNGs **are committed to the repository** — regenerate and commit them
whenever the SVG changes.

With `rsvg-convert` (`brew install librsvg`):

```sh
for size in 16 32 48 128; do
  rsvg-convert -w $size -h $size assets/icon.svg -o assets/icon$size.png
done
```

Or with `sips`, which ships with macOS:

```sh
for size in 16 32 48 128; do
  sips -s format png -z $size $size assets/icon.svg --out assets/icon$size.png
done
```

Or with ImageMagick:

```sh
for size in 16 32 48 128; do
  magick -background none assets/icon.svg -resize ${size}x${size} assets/icon$size.png
done
```

Check `icon16.png` at actual size before committing — that is the one that has
to survive being 16 pixels wide in a toolbar.

## Licence

MIT.

## Development harness

`src/content/content.js` and `src/content/inject.js` need a browser, so they
cannot be unit tested. `dev/` provides a fake watch page that mounts the real
content scripts against a real caption fixture, with a stand-in worker that runs
the real transcript, prompt and markdown modules and only fakes the provider
request.

```sh
python3 dev/serve.py            # then open http://localhost:8777/watch?v=aircAruvnKk
```

The page has controls for the cases that are awkward to reach on YouTube:
simulating an SPA navigation to another video, and serving a video with no
caption tracks. `window.__harnessPace = 30` slows the fake stream down so you
can catch it mid-flight and press Stop.

It is a development tool, not a test suite — it does not assert, it lets you
look. The assertions live in `test/`, and the browser-only checks live in
[docs/manual-qa.md](docs/manual-qa.md).

`dev/` is inert inside the loaded extension: `manifest.json` does not reference
it and the extension declares no `web_accessible_resources`, so no page can
reach those files. Delete the folder before packaging for a store listing if you
would rather not ship it at all.
