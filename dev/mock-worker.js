// Stands in for src/background/worker.js inside the harness page.
//
// It runs the REAL transcript, chunking, prompt and markdown modules — only the
// network call to the AI provider is faked, by replaying a canned markdown
// document token by token. So a harness run exercises everything between the
// button click and the painted summary except the provider request itself.

import { parseJson3, pickTrack, cuesToText } from '/src/lib/transcript.js';
import { buildSystemPrompt, buildSummaryPrompt, buildQuestionPrompt } from '/src/lib/prompt.js';
import { renderMarkdown, linkifyTimestamps } from '/src/lib/markdown.js';

const SUMMARY = `## TL;DR
Neural networks are layered functions that learn their weights from data. This
first chapter builds the intuition with a handwritten-digit classifier, showing
what a "neuron" and a "layer" actually are before any calculus appears.

## Key points
- [0:04] A neuron holds one number between 0 and 1, its **activation**.
- [0:12] The 784 input neurons are the pixels of a 28x28 image, flattened.
- [0:20] Weights decide which pattern a neuron looks for; the bias decides how
  much evidence it needs before firing.
- [0:32] The whole network is one function with 13,002 knobs, and learning means
  turning them.

## Walkthrough
- [0:00] Why digit recognition is the right first problem.
- [0:16] Layers, and what the hidden ones might be picking out.
- [0:28] Matrix notation, and why it collapses the whole thing to one line.

## Worth watching?
Worth it if you want intuition before formalism. Skip it if you already know
what a weight matrix is — the TL;DR above is enough.`;

const ANSWER = `Yes — [0:12] is the moment that matters. The input layer is the
image itself: one neuron per pixel, 784 of them, each holding that pixel's
brightness. Nothing clever happens there; the interesting part starts at the
first hidden layer.`;

/** The harness's own log, surfaced in the page so a test can assert on it. */
export const log = [];
function note(...args) {
  log.push(args.join(' '));
  console.log('[mock-worker]', ...args);
}

function makePort(onToPage) {
  const listeners = [];
  const disconnects = [];
  let cancelled = false;
  let state = { meta: null, cues: null, transcriptText: '' };

  const post = (msg) => listeners.forEach((fn) => fn(msg));
  // Not setTimeout: Chrome clamps timers to ~1s in a background tab, which turns
  // a 170-chunk stream into three minutes. A MessageChannel round trip is a real
  // macrotask boundary and is not throttled.
  const tick = () =>
    new Promise((r) => {
      const c = new MessageChannel();
      c.port1.onmessage = () => r();
      c.port2.postMessage(0);
    });

  async function stream(markdown) {
    cancelled = false;
    let buffer = '';
    // window.__harnessPace (ms) slows the stream down so a test can click Stop
    // mid-flight. Bigger chunks then, or a paced run takes minutes: Chrome
    // clamps timers to ~1s in a background tab.
    const pace = Number(window.__harnessPace) || 0;
    const size = pace ? 120 : 7;
    // Chunked the way an SSE stream arrives: mid-word, mid-tag, mid-timestamp.
    for (let i = 0; i < markdown.length; i += size) {
      if (cancelled) return null;
      buffer += markdown.slice(i, i + size);
      post({ type: 'render', text: buffer, html: linkifyTimestamps(renderMarkdown(buffer)) });
      if (pace) await new Promise((r) => setTimeout(r, pace));
      else await tick();
    }
    return buffer;
  }

  async function handle(msg) {
    if (msg.type === 'cancel') {
      cancelled = true;
      return;
    }

    if (msg.type === 'begin') {
      state.meta = msg.meta;
      note('begin', msg.meta?.title, 'tracks:', (msg.tracks || []).length);
      if (!msg.tracks?.length) {
        post({ type: 'error', code: 'NO_CAPTIONS', message: 'This video has no captions.' });
        return;
      }
      const track = pickTrack(msg.tracks, { lang: 'en' });
      post({ type: 'fetchTrack', baseUrl: track.baseUrl, trackInfo: track });
      return;
    }

    if (msg.type === 'run') {
      const cues = msg.cues?.length ? msg.cues : parseJson3(msg.json3);
      note('run: strategy', msg.strategy, 'mode', msg.mode, 'cues', cues.length);
      if (!cues.length) {
        post({ type: 'error', code: 'TRACK_EMPTY', message: 'Empty caption track.' });
        return;
      }
      state.cues = cues;
      state.transcriptText = cuesToText(cues);

      // Prove the real prompt builders run over real cues; the harness asserts
      // on these lengths so a broken builder fails the run rather than silently
      // producing an empty prompt.
      const prompt = buildSummaryPrompt({
        meta: state.meta,
        transcriptText: state.transcriptText,
        mode: msg.mode,
      });
      note('system prompt chars', buildSystemPrompt().length, '| user prompt chars', prompt.length);

      const last = cues[cues.length - 1];
      const covered = (last?.t || 0) + (last?.d || 0);
      const duration = Number(state.meta?.duration) || 0;
      if (duration > 0 && covered < duration * 0.75) {
        post({
          type: 'warning',
          code: 'PARTIAL_TRANSCRIPT',
          message: `Only the first ${Math.round((covered / duration) * 100)}% of this video has a transcript.`,
        });
      }

      post({ type: 'status', stage: 'summarizing' });
      const text = await stream(SUMMARY);
      if (text === null) return; // cancelled
      post({ type: 'done', text, html: linkifyTimestamps(renderMarkdown(text)) });
      return;
    }

    if (msg.type === 'ask') {
      note('ask:', msg.question);
      buildQuestionPrompt({
        meta: state.meta,
        transcriptText: state.transcriptText,
        question: msg.question,
      });
      post({ type: 'status', stage: 'summarizing' });
      const text = await stream(ANSWER);
      if (text === null) return;
      post({
        type: 'done',
        text,
        html: linkifyTimestamps(renderMarkdown(text)),
        answer: text,
      });
    }
  }

  return {
    name: 'vse',
    postMessage: (msg) => {
      onToPage(msg);
      handle(msg);
    },
    disconnect: () => disconnects.forEach((fn) => fn()),
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnects.push(fn) },
  };
}

/** Install a `chrome` good enough for content.js, before content.js loads. */
export function installChromeShim({ autoRun = false, defaultMode = 'detailed' } = {}) {
  const session = new Map();
  const sent = [];

  window.chrome = {
    runtime: {
      id: 'harness',
      lastError: null,
      connect: () => makePort((msg) => sent.push(msg)),
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === 'getSettings') return { autoRun, defaultMode, lang: 'en' };
        if (msg.type === 'openOptions') {
          note('openOptions requested');
          return { ok: true };
        }
        return { ok: false };
      },
      openOptionsPage: () => note('openOptionsPage'),
    },
    storage: {
      session: {
        get: async (k) => (session.has(k) ? { [k]: session.get(k) } : {}),
        set: async (obj) => Object.entries(obj).forEach(([k, v]) => session.set(k, v)),
        remove: async (k) => session.delete(k),
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  };

  window.__harness = { sent, log, session };
}
