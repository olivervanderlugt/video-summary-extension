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

**`POST /youtubei/v1/get_transcript` — removed, do not re-add.** Measured
2026-08-21: 400 `FAILED_PRECONDITION` from curl with the page's full
INNERTUBE_CONTEXT + visitorData + cookies, 400 from a real browser session, and
400 when YouTube's own UI issued it on a signed-out profile. Bot detection that
landed ~2025-12 (LuanRT/YouTube.js #1102). YouTube's own transcript panel has
moved to `POST /youtubei/v1/get_panel` (200 / 453,443 bytes on `g2cQ2kD6lzs`),
so strategy C was calling an endpoint YouTube itself abandoned. There is no
request shape that fixes it.

**Wrapping `window.fetch` to sniff the token.** Any YouTube code calling fetch
unbound lands in the wrapper with `this === undefined`; applying native fetch to
that throws and breaks YouTube's own requests. XHR only.

## Shape decisions

**Two transcript strategies, not three** (caption fetch with a borrowed token,
panel scrape). `get_transcript` is gone — see Rejected approaches.

**The panel is no longer the weaker fallback.** Measured 2026-08-21: the panel
does not virtualise, so every segment is in the DOM at once (2,064 on a 1h49
video), and it populates in ~403 ms. Meanwhile the caption fetch depends on a
token we cannot mint and only get by borrowing, and `exp=xpe`/`xpv` on the
track's `baseUrl` tells us up front whether it is even needed. Caption fetch is
still tried first because when the player has already issued its own request the
token is free and the whole thing costs ~105 ms — but the panel is the path that
works without a token, and it is budgeted accordingly rather than as a
last resort.

**The panel scraper must keep handling two DOM generations.** Legacy
(`ytd-transcript-segment-renderer` / `.segment-timestamp` / `.segment-text`) and
modern (`transcript-segment-view-model.ytwTranscriptSegmentViewModelHost` /
`div.ytwTranscriptSegmentViewModelTimestamp` / `span.ytAttributedStringHost`)
are both live, and which one you get varies per video on the same profile in the
same session. Querying only legacy returned nothing on modern-layout videos.
Modern's `div.ytwTranscriptSegmentViewModelTimestampA11yLabel` must be excluded
from the text or it lands in the transcript. Do not delete either branch until a
measurement says one generation is gone.

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
