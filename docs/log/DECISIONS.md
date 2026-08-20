# Decisions

Why things are the way they are, including what was considered and rejected. If
you are about to "fix" something on this list, read the entry first.

## Constraints that are not up for negotiation

**No dependencies, no build step.** This tool holds people's API keys.
Auditability is the feature. Load unpacked has to work on a fresh clone.

**No telemetry.** The README, PRIVACY.md and the settings page all promise it.
That promise is the reason a cautious person picks this over the alternatives.
Feedback comes from a pre-filled GitHub issue, a copy-diagnostics button, and
local counters the user can choose to share.

**The key never leaves the service worker.** The content script runs on
youtube.com and is a relay: it owns no key and parses nothing.

**The key is stored unencrypted and we say so.** Encrypting it would mean
storing the passphrase beside the ciphertext. The honest mitigation is scope:
mint a key for this extension, put a spend limit on it.

## Rejected approaches

**Restoring the reverse ASR-dedup branch.** It deleted a cue outright — text and
timestamp. Losing content is worse than the duplicate line it prevented.

**Capping `stripDelimiters` without a fallback.** Capping alone traded a 7s
freeze for a successful prompt-injection escape. It now caps *and* neutralises
every `<` if a delimiter still survives.

**A banned-word list in the prompt beyond the structure verbs.** Misfires on
legitimate subject vocabulary and collides with "keep the speaker's own
terminology".

**Placeholders for a failed map section.** "Reads as complete and is not" is this
product's worst failure. Retry once, then fail honestly.

**Starting playback to capture a token.** It is the viewer's video.

**Wrapping `window.fetch` to sniff the token.** Any YouTube code calling fetch
unbound lands in the wrapper with `this === undefined`; applying native fetch to
that throws and breaks YouTube's own requests. XHR only.

## Shape decisions

**Three transcript strategies** (caption fetch, panel scrape, get_transcript)
because each has been measured to fail in situations the others survive.

**Two-round-trip transcript handshake** (begin → fetchTrack → run) because track
selection needs the user's language preference, which lives in the worker.

**`parseTimestamp` is deliberately duplicated** in `src/lib/transcript.js` and
`src/content/inject.js`. A MAIN-world classic script cannot import an ES module,
and the two intentionally differ: the lib returns 0 for unparseable input, inject
returns NaN so a garbled row is dropped instead of becoming a cue at t=0.

**Summary modes each do one thing.** Brief is the TL;DR alone; Detailed adds
folded Key points; Bullets is points only; Explain simply is two plain
paragraphs; Quotes caps at six. Walkthrough and "Worth watching?" were removed —
no mode asked for them and describing them invited the model to write them.
