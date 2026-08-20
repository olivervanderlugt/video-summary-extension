# Security

This extension holds your AI provider API key. If you find a way to get at that
key, or at a user's transcript, tell me privately before telling anyone else.

**Report:** open a [private advisory](https://github.com/olivervanderlugt/video-summary-extension/security/advisories/new).
Not a public issue.

I will confirm I've read it within a few days, tell you whether I agree it's a
problem, and credit you when it's fixed unless you'd rather I didn't.

## In scope

- Anything that lets a page on youtube.com, another extension, or a website read
  a stored key.
- Anything that sends the key or the transcript somewhere the user did not
  configure.
- Prompt injection through video captions, titles or chapter labels that escapes
  the transcript block and reaches the model as instruction.
- Anything that makes the extension's output produce markup rather than text.

## Not in scope

- The key being stored unencrypted in `chrome.storage.local`. That is known,
  documented, and deliberate — encrypting it would mean storing the passphrase
  next to the ciphertext, which protects nobody. Anyone with access to your
  Chrome profile can already read your saved passwords.
- Anything requiring a hostile extension to already be installed with
  permissions of its own.
- Your provider's handling of the transcript once it arrives. That is their
  privacy policy, not this one.

## What the extension does with your key

It lives in `chrome.storage.local`, never `chrome.storage.sync`, so it is never
uploaded to your Google account. It is read only by the background service
worker, which is the only place any provider request is made. The content script
running on youtube.com never receives it.

Mint a key used only by this extension and put a spend limit on it. Then a leak
costs a bounded amount and is fixed by revoking one key.
