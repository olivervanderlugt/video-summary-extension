# Privacy Policy

Last updated: 2026-08-20

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
generativelanguage.googleapis.com, openrouter.ai, or the custom server URL you
entered. There is no intermediary. Once the data reaches your provider it is
subject to that provider's privacy and data-retention policy, which is worth
reading, because it is the only policy that governs it.

If OpenRouter is the provider you chose, then OpenRouter is who receives the
transcript. It is a proxy in front of Anthropic, OpenAI and Google models: it
sees the request, bills you for it, and passes it on to whichever model you
picked, under its own agreement with that model's owner. Two policies apply in
that case — OpenRouter's and the underlying provider's.

No video content, audio, or your YouTube account information is read or sent.
The extension reads the caption track the video already publishes.

## The OpenRouter sign-in

Signing in to OpenRouter is optional — pasting a key works instead — and it is
the only flow in the extension that talks to anyone before you ask for a
summary. What it sends:

- To `https://openrouter.ai/auth`, opened in a popup window: the SHA-256 hash of
  a random verifier the extension just generated, and the extension's own
  callback URL, which is of the form `https://<extension-id>.chromiumapp.org/`.
  That URL tells OpenRouter the extension's ID. Nothing else about you or your
  browser is put in that request.
- To `https://openrouter.ai/api/v1/auth/keys`: the one-time code OpenRouter
  redirected back with, plus the verifier. OpenRouter answers with a key.

Whatever you do on OpenRouter's own page while the popup is open — logging in,
creating an account, paying them — is between you and OpenRouter, under their
privacy policy, and the extension can see none of it. It only ever receives the
code in the redirect.

The key that comes back is stored exactly like a pasted one: `chrome.storage.local`,
unencrypted, same as every other key here. Signing in changes how the key is
obtained, not where it is kept or how it is protected.

The `identity` permission exists for this popup and for nothing else. The
extension calls only `chrome.identity.launchWebAuthFlow` and
`chrome.identity.getRedirectURL`. It never calls `getProfileUserInfo` or any
other API that would tell it your Chrome profile, your Google account, your
email address, or whether you are signed in to Chrome at all — and the manifest
does not request the `identity.email` permission that would be needed to read
the last of those.

## What is stored, and where

In `chrome.storage.local`, on this machine only:

- your API keys, one per provider, stored unencrypted — including one obtained
  by signing in to OpenRouter, which is stored no differently from one you typed
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
provider's console, and is worth doing if you think the key was exposed. That
includes a key from the OpenRouter sign-in: deleting it here deletes this copy
of it, but the key stays live at OpenRouter until you revoke it at
<https://openrouter.ai/keys>.

## Permissions, and why each exists

- `storage` — to keep your settings and keys on this machine.
- `identity` — to open the OpenRouter sign-in popup and receive its redirect.
  Nothing else, as described above.
- Access to `www.youtube.com` — to add the Summarize button to watch pages and
  read the caption track.
- Access to the four provider API hosts — api.anthropic.com, api.openai.com,
  generativelanguage.googleapis.com and openrouter.ai — to send your summary
  request to the one you chose.
- Optional host access, requested at the moment you enter a custom server URL,
  and only for that server.

There is no `<all_urls>`, no `tabs`, and no `webRequest` permission. The
extension cannot see your other tabs or your browsing history.

## Changes

Any change to this policy will be a commit in this repository, with a visible
diff. There is no other version of it.
