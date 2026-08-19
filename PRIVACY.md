# Privacy Policy

Last updated: 2026-08-19

Video Summary is a browser extension that runs entirely on your machine. It has
no server, no account, and no operator with access to your data.

## What we collect

Nothing. There is no backend to collect anything with. No analytics, no crash
reporting, no usage counters, no unique identifier, no phone-home on install or
update.

## What leaves your browser, and where it goes

When — and only when — you ask for a summary, the extension sends a single
request to the AI provider **you** configured with **your** API key. That
request contains:

- the video's title, channel name, and duration
- its chapter titles, if the video has chapters
- the text of its caption track
- your prompt settings (summary style, output length) and, if you ask a
  follow-up question, the question and the preceding turns of that conversation

It goes to that provider and nowhere else — api.anthropic.com, api.openai.com,
generativelanguage.googleapis.com, or the custom server URL you entered. There
is no intermediary. Once the data reaches your provider it is subject to that
provider's privacy and data-retention policy, which is worth reading, because it
is the only policy that governs it.

No video content, audio, or your YouTube account information is read or sent.
The extension reads the caption track the video already publishes.

## What is stored, and where

In `chrome.storage.local`, on this machine only:

- your API keys, one per provider, stored unencrypted
- your chosen provider, model, caption language, summary style, output limit,
  and the auto-summarise toggle

Nothing is written to `chrome.storage.sync`, so nothing is uploaded to your
Google account or copied to your other devices. Summaries themselves are not
saved; they exist in the page until you navigate away.

Storing the key unencrypted is a deliberate, stated choice: an encryption key
kept next to the ciphertext is decoration, not protection. The keys sit where
Chrome's own saved passwords sit, and anyone with access to your Chrome profile
directory can read them. Mint a key that is used only by this extension and set
a spend limit on it.

## What never happens

- Your API key is never sent anywhere except to the provider it belongs to, as
  that provider's own authentication header.
- Your key is never exposed to the YouTube page. It is read only by the
  extension's background service worker; page scripts cannot reach it.
- No data is sold, shared, or transmitted to the extension's authors, because
  there is no channel through which that could happen.
- No remote code is loaded or executed. Everything that runs ships in the
  extension.

## How to delete everything

Open the extension's options page and press **Delete all stored data**, then
confirm. That clears every key and setting immediately. Uninstalling the
extension also removes its storage. Revoking the API key itself is done in your
provider's console, and is worth doing if you think the key was exposed.

## Permissions, and why each exists

- `storage` — to keep your settings and key on this machine.
- Access to `www.youtube.com` — to add the Summarize button to watch pages and
  read the caption track.
- Access to the three provider API hosts — to send your summary request.
- Optional host access, requested at the moment you enter a custom server URL,
  and only for that server.

There is no `<all_urls>`, no `tabs`, and no `webRequest` permission. The
extension cannot see your other tabs or your browsing history.

## Changes

Any change to this policy will be a commit in this repository, with a visible
diff. There is no other version of it.
