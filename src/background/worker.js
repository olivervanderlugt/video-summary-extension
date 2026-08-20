// Service worker: the only place an API key ever exists.
//
// The content script is deliberately dumb. It relays the raw player data it
// scraped from the page and renders whatever HTML comes back. Everything that
// touches the key, the provider, or the prompt happens here, out of reach of
// any script running on youtube.com.

import { getProvider } from '../providers/index.js';
import { sseEvents } from '../lib/sse.js';
import { parseJson3, pickTrack, cuesToText } from '../lib/transcript.js';
import { chunkCues } from '../lib/chunk.js';
import {
  buildSystemPrompt,
  buildSummaryPrompt,
  buildChunkPrompt,
  buildReducePrompt,
  buildQuestionPrompt,
} from '../lib/prompt.js';
import { renderMarkdown, linkifyTimestamps, foldSection } from '../lib/markdown.js';
import { createVerifier, challengeFor, authUrl, codeFromRedirect } from '../lib/pkce.js';

const DEFAULTS = {
  provider: 'openrouter', // sign-in beats hunting for an API key
  keys: { anthropic: '', openai: '', gemini: '', openrouter: '', compatible: '' },
  model: '',
  baseUrl: '',
  lang: 'en',
  defaultMode: 'detailed',
  autoRun: false,
  openPanel: false, // show the panel expanded on every watch page
  maxTokens: 4000,
};

// Past this many characters a single request stops being a good idea: some
// providers reject it outright, and the ones that don't produce a summary that
// quietly ignores the middle of the video. Above the threshold we map-reduce.
const SINGLE_PASS_CHARS = 100_000;
// The provider codes worth one more attempt; everything else is a real answer.
const RETRYABLE = new Set(['rate_limit', 'server']);
// Long enough that a rate limit has a chance to clear, short enough that a user
// waiting on a summary does not think it hung.
const RETRY_DELAY_MS = 1500;
const RENDER_INTERVAL_MS = 80;

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(stored.settings || {}) };
  s.keys = { ...DEFAULTS.keys, ...(s.keys || {}) };
  return s;
}

function activeKey(settings) {
  return (settings.keys?.[settings.provider] || '').trim();
}

function activeModel(settings, adapter) {
  return (settings.model || '').trim() || adapter.defaultModel;
}

/**
 * A custom base URL belongs to the OpenAI-compatible provider and to nothing
 * else. `baseUrl` is one stored field, so a URL left behind from a session with
 * a local proxy would otherwise be handed the user's real Anthropic or OpenAI
 * key on the next summary. Read it only when the active adapter asks for one.
 */
function activeBaseUrl(settings, adapter) {
  if (adapter.fixedBaseUrl) return adapter.fixedBaseUrl; // not user-supplied, so not user-redirectable
  if (!adapter.requiresBaseUrl) return '';
  const baseUrl = (settings.baseUrl || '').trim();
  // Fail closed. An adapter that asks for a base URL must never fall back to
  // another vendor's default: that ships the key and the whole transcript to a
  // company the user never picked, over a host permission we always hold.
  if (!baseUrl) {
    throw new AppError(
      'NO_BASE_URL',
      `${adapter.label} needs a Base URL. Open the extension settings and enter the address of your server — nothing is sent until you do.`
    );
  }
  return baseUrl;
}

class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Anything thrown inside a run is funnelled through here before it reaches a user. */
function toUserError(err) {
  if (err?.name === 'AbortError') return { code: 'CANCELLED', message: 'Stopped.' };
  // AppError from this file and ProviderError from the adapters both carry the
  // code the panel keys its copy off — and the code the retry below reads.
  if (typeof err?.code === 'string' && err.code) return { code: err.code, message: err.message };
  if (err instanceof TypeError) {
    return {
      code: 'NETWORK',
      message:
        'Could not reach the AI provider. Check your connection, and if you use a custom base URL, that it is correct and permitted.',
    };
  }
  return { code: 'UNKNOWN', message: err?.message || 'Something went wrong.' };
}

/**
 * One streaming completion. Yields text deltas.
 * The adapter owns every provider-specific detail; this function owns none.
 */
async function* streamCompletion({ settings, adapter, system, messages, signal, onTruncated = () => {} }) {
  const key = activeKey(settings);
  if (!key) {
    throw new AppError(
      'NO_KEY',
      'No API key set yet. Open the extension settings and add a key for your provider.'
    );
  }

  const { url, headers, body } = adapter.buildRequest({
    key,
    model: activeModel(settings, adapter),
    baseUrl: activeBaseUrl(settings, adapter),
    requiresBaseUrl: !!adapter.requiresBaseUrl,
    system,
    messages,
    maxTokens: Number(settings.maxTokens) || DEFAULTS.maxTokens,
  });

  // Bound the response HEADERS only. Wrapping the whole request in a timeout
  // would abort the body mid-stream and kill a legitimately long reduce pass.
  const headersTimer = new AbortController();
  const headersDeadline = setTimeout(() => headersTimer.abort(), 60_000);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any ? AbortSignal.any([signal, headersTimer.signal]) : signal,
    });
  } catch (err) {
    // A timeout abort reported as CANCELLED would paint a silent empty done,
    // which is worse than the hang it replaces.
    if (headersTimer.signal.aborted) {
      throw new AppError('NETWORK', 'The provider did not respond within a minute. Try again, or check the base URL if you set one.');
    }
    throw err;
  } finally {
    clearTimeout(headersDeadline);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const { code, message } = adapter.parseError(response.status, text);
    throw new AppError(code, message);
  }
  if (!response.body) {
    throw new AppError('EMPTY', 'The provider returned an empty response.');
  }

  let got = false;
  let truncated = false;
  for await (const event of sseEvents(response.body)) {
    if (adapter.isTruncated && adapter.isTruncated(event)) truncated = true;
    const delta = adapter.extractDelta(event);
    if (delta) {
      got = true;
      yield delta;
    }
  }
  // A response cut off at max_tokens ends its stream normally, so without this
  // the half answer is painted, marked done, and cached as complete — the exact
  // failure this file's coverage guard exists to prevent.
  if (truncated) onTruncated();

  if (!got) {
    throw new AppError(
      'EMPTY',
      'The provider accepted the request but returned no text. This usually means the model refused the content or the request was too long.'
    );
  }
}

/**
 * One more attempt, and only for the two failures that are usually transient.
 * Never a placeholder and never a skipped section: a summary that reads as
 * complete and is not is the worst thing this can ship, so a second failure
 * fails the whole run.
 */
async function withRetry(attempt, onRetry) {
  try {
    return await attempt();
  } catch (err) {
    if (!RETRYABLE.has(err?.code)) throw err;
    onRetry?.();
    // A 429 answered instantly is a 429 again, and a second billed request.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return attempt();
  }
}

async function collect(iterator) {
  let out = '';
  for await (const chunk of iterator) out += chunk;
  return out;
}

/** Per-connection state. One port is one panel is one video. */
class Session {
  constructor(port) {
    this.port = port;
    this.meta = null;
    this.cues = null;
    this.transcriptText = '';
    this.history = [];
    this.controller = null;
    this.buffer = '';
    this.lastRender = 0;
    this.renderTimer = null;
  }

  /**
   * Buffered markdown as the panel will show it. In detailed mode the bullets
   * are folded away: the TL;DR is the answer, and the points are there for
   * anyone who wants to check it rather than something that should push the
   * answer off the screen.
   */
  html(final = false) {
    const rendered = linkifyTimestamps(renderMarkdown(this.buffer));
    // Only on the last render. Folding mid-stream makes the panel appear to
    // stall the moment `## Key points` arrives, and re-collapses a fold the
    // reader just opened on the next throttled paint 80ms later.
    return final && this.mode === 'detailed' ? foldSection(rendered, 'Key points') : rendered;
  }

  post(msg) {
    try {
      this.port.postMessage(msg);
    } catch {
      // Panel went away mid-stream (navigation, tab close). Nothing to do.
    }
  }

  status(stage, detail) {
    this.post({ type: 'status', stage, detail });
  }

  /** Throttled so a fast stream doesn't spend all its time re-rendering markdown. */
  pushRender(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRender < RENDER_INTERVAL_MS) {
      if (!this.renderTimer) {
        this.renderTimer = setTimeout(() => {
          this.renderTimer = null;
          this.pushRender(true);
        }, RENDER_INTERVAL_MS);
      }
      return;
    }
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.lastRender = now;
    this.post({
      type: 'render',
      text: this.buffer,
      html: this.html(),
    });
  }

  /**
   * An MV3 service worker is killed after ~30s without an event. A connected
   * port is supposed to keep it alive, but the gap before a slow model's first
   * token is exactly the window where being wrong about that costs the user a
   * paid request that never arrives. A cheap ping removes the doubt.
   */
  startKeepalive() {
    clearInterval(this.keepalive);
    this.keepalive = setInterval(() => this.post({ type: 'ping' }), 20_000);
  }

  stopKeepalive() {
    clearInterval(this.keepalive);
    this.keepalive = null;
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.stopKeepalive();
  }

  /**
   * Step 1 of the transcript handshake. The page gave us the track list; we
   * choose one (the choice depends on the user's language preference, which
   * lives here) and ask the page to fetch it.
   */
  async begin({ meta, tracks }) {
    this.meta = meta;
    const settings = await loadSettings();

    if (!tracks || tracks.length === 0) {
      this.post({
        type: 'error',
        code: 'NO_CAPTIONS',
        message:
          'This video has no captions, so there is no transcript to summarize. YouTube auto-captions count — this video has neither.',
      });
      return;
    }

    const track = pickTrack(tracks, { lang: settings.lang });
    if (!track) {
      this.post({
        type: 'error',
        code: 'NO_CAPTIONS',
        message: 'No usable caption track was found for this video.',
      });
      return;
    }
    this.post({ type: 'fetchTrack', baseUrl: track.baseUrl, trackInfo: track });
  }

  /**
   * Step 2: summarize. The page resolves the transcript by whichever strategy
   * works on the day — the caption-track fetch gives us raw json3 to parse,
   * while the transcript-panel and get_transcript paths hand back cues already.
   * Both arrive here.
   */
  async run({ json3, cues: readyCues, trackInfo, mode }) {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.buffer = '';
    this.history = [];
    this.startKeepalive();

    try {
      const settings = await loadSettings();
      const adapter = getProvider(settings.provider);

      const scraped = Array.isArray(readyCues) && readyCues.length > 0;
      const cues = scraped ? readyCues : parseJson3(json3);
      if (!cues.length) {
        throw new AppError(
          'TRACK_EMPTY',
          'YouTube returned an empty caption track for this video. This sometimes fixes itself on a reload.'
        );
      }
      this.cues = cues;
      this.transcriptText = cuesToText(cues);

      const meta = {
        ...this.meta,
        // Never inferred. The scraping strategies take whichever track YouTube
        // had selected — often a human-authored one — so "scraped" says nothing
        // about how the captions were made. Pass on what the page told us and
        // leave it undefined when it told us nothing: an unfounded "auto" hedges
        // correct figures into vagueness, an unfounded "human" does the reverse.
        isAuto: trackInfo?.isAuto,
        lang: trackInfo?.languageCode,
      };

      // A transcript that stops long before the video does is the dangerous
      // failure: the summary reads as complete and is not. The panel-scraping
      // strategy can truncate silently if YouTube virtualises its transcript
      // list, so the check lives here, where every strategy passes through.
      const last = cues[cues.length - 1];
      const covered = (last?.t || 0) + (last?.d || 0);
      const duration = Number(meta.duration) || 0;
      if (duration > 0 && covered > 0 && covered < duration * 0.75) {
        meta.coverageNote = `the transcript ends at ${Math.round(covered / 60)} min of a ${Math.round(duration / 60)} min video`;
        this.post({
          type: 'warning',
          code: 'PARTIAL_TRANSCRIPT',
          message: `Only the first ${Math.round((covered / duration) * 100)}% of this video has a transcript. The summary covers that part only.`,
        });
      }
      this.meta = meta;
      const system = buildSystemPrompt();
      const useMode = mode || settings.defaultMode;
      // Remembered so html() can fold the right section, and so an Ask answer
      // rendered later is not folded as though it were a summary.
      this.mode = useMode;

      let final;
      if (this.transcriptText.length <= SINGLE_PASS_CHARS) {
        this.status('summarizing');
        final = await this.streamInto({
          settings,
          adapter,
          system,
          messages: [
            {
              role: 'user',
              content: buildSummaryPrompt({
                meta,
                transcriptText: this.transcriptText,
                mode: useMode,
              }),
            },
          ],
          signal: controller.signal,
          onRetry: () => this.status('summarizing', { retry: true }),
        });
      } else {
        final = await this.mapReduce({ settings, adapter, system, meta, mode: useMode, controller });
      }

      this.history = [
        { role: 'user', content: `Summarize this video: ${meta.title}` },
        { role: 'assistant', content: final },
      ];
      this.pushRender(true);
      this.post({
        type: 'done',
        text: this.buffer,
        html: this.html(true),
      });
    } catch (err) {
      const { code, message } = toUserError(err);
      if (code !== 'CANCELLED') this.post({ type: 'error', code, message });
      else this.post({ type: 'done', text: this.buffer, html: this.html(true), cancelled: true });
    } finally {
      this.controller = null;
      this.stopKeepalive();
    }
  }

  async streamInto({ settings, adapter, system, messages, signal, onRetry }) {
    // A response cut off at max_tokens ends its stream normally, so nothing
    // downstream can tell a finished summary from a severed one.
    const onTruncated = () =>
      this.post({
        type: 'warning',
        code: 'TRUNCATED',
        message:
          'The answer hit the length limit and stops mid-thought. Raise "Maximum answer length" in settings, or choose a shorter summary style.',
      });
    const start = this.buffer.length;
    await withRetry(async () => {
      // A retry starts the answer over; the half that broke must not stay in
      // the buffer, or the panel shows it twice.
      this.buffer = this.buffer.slice(0, start);
      for await (const delta of streamCompletion({ settings, adapter, system, messages, signal, onTruncated })) {
        this.buffer += delta;
        this.pushRender();
      }
    }, onRetry);
    return this.buffer.slice(start);
  }

  /**
   * Long video: summarize windows of the transcript, then summarize those.
   * Only the reduce pass streams — the map passes report progress instead, so
   * the panel doesn't fill with intermediate text the user never asked for.
   */
  async mapReduce({ settings, adapter, system, meta, mode, controller }) {
    const chunks = chunkCues(this.cues);
    const partials = [];

    for (const chunk of chunks) {
      this.status('section', { index: chunk.index + 1, total: chunks.length });
      const text = cuesToText(chunk.cues);
      // `mode` matters here too: without it the map pass paraphrases, and the
      // reduce pass then asks for verbatim quotes from notes that hold none.
      const messages = [
        { role: 'user', content: buildChunkPrompt({ meta, chunk, transcriptText: text, mode }) },
      ];
      const partial = await withRetry(
        () => collect(streamCompletion({ settings, adapter, system, messages, signal: controller.signal })),
        () => this.status('section', { index: chunk.index + 1, total: chunks.length, retry: true })
      );
      partials.push(partial);
    }

    // The reduce pass is the expensive one to lose: failing it throws away every
    // map call the user already paid for.
    this.status('summarizing');
    return this.streamInto({
      settings,
      adapter,
      system,
      messages: [{ role: 'user', content: buildReducePrompt({ meta, partials, mode }) }],
      signal: controller.signal,
      onRetry: () => this.status('summarizing', { retry: true }),
    });
  }

  /** Follow-up question over the transcript already in this session. */
  async ask({ question }) {
    if (!this.transcriptText) {
      this.post({
        type: 'error',
        code: 'NO_TRANSCRIPT',
        message: 'Summarize the video first, then ask about it.',
      });
      return;
    }
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.buffer = '';
    this.mode = null; // an answer is prose, never a folded summary
    this.startKeepalive();

    try {
      const settings = await loadSettings();
      const adapter = getProvider(settings.provider);
      const messages = [
        ...this.history,
        {
          role: 'user',
          content: buildQuestionPrompt({
            meta: this.meta,
            transcriptText: this.transcriptText,
            question,
          }),
        },
      ];
      const answer = await this.streamInto({
        settings,
        adapter,
        system: buildSystemPrompt(),
        messages,
        signal: controller.signal,
      });
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      this.pushRender(true);
      // `answer` carries the text, not a flag: the panel reads
      // `msg.answer || msg.text` when appending to the Q&A thread.
      this.post({
        type: 'done',
        text: this.buffer,
        html: this.html(true),
        answer: this.buffer,
      });
    } catch (err) {
      const { code, message } = toUserError(err);
      if (code !== 'CANCELLED') this.post({ type: 'error', code, message });
    } finally {
      this.controller = null;
      this.stopKeepalive();
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vse') return;
  const session = new Session(port);

  // Every handler is async and none of them is awaited, so a rejection would
  // otherwise be an unhandled promise and the panel would sit on its spinner
  // forever with nothing to click. Fail loudly into the panel instead.
  const dispatch = (fn, msg) =>
    Promise.resolve()
      .then(() => fn.call(session, msg))
      .catch((err) => {
        const { code, message } = toUserError(err);
        if (code !== 'CANCELLED') session.post({ type: 'error', code, message });
      });

  port.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'begin':
        dispatch(session.begin, msg);
        break;
      case 'run':
        dispatch(session.run, msg);
        break;
      case 'ask':
        dispatch(session.ask, msg);
        break;
      case 'cancel':
        session.cancel();
        break;
    }
  });

  port.onDisconnect.addListener(() => session.cancel());
});

/**
 * Sign in to OpenRouter and store the key it mints for us.
 *
 * This is the only provider of the four that offers a sanctioned way for a
 * third-party app to obtain a user's credential: Anthropic prohibits
 * subscription OAuth in third-party tools and issues no client IDs, and OpenAI
 * has no authorization endpoint that mints a user-billed key. PKCE means no
 * client secret, which is what makes it usable from an extension at all.
 */
async function signInWithOpenRouter() {
  if (!chrome.identity?.launchWebAuthFlow) {
    return { ok: false, code: 'NO_IDENTITY', message: 'This browser does not support the sign-in flow. Paste an API key instead.' };
  }

  const verifier = createVerifier();
  const challenge = await challengeFor(verifier);
  const callbackUrl = chrome.identity.getRedirectURL();

  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: authUrl({ callbackUrl, challenge }),
      interactive: true,
    });
  } catch (err) {
    // The user closing the window is the common case, and is not an error.
    const message = String(err?.message || err);
    return /cancel|closed by the user/i.test(message)
      ? { ok: false, code: 'CANCELLED', message: 'Sign-in cancelled.' }
      : { ok: false, code: 'AUTH_FAILED', message: `Sign-in did not complete: ${message}` };
  }

  const code = codeFromRedirect(redirect);
  if (!code) {
    return { ok: false, code: 'NO_CODE', message: 'OpenRouter did not return an authorization code. Try again, or paste a key instead.' };
  }

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: 'Could not reach OpenRouter to finish signing in. Check your connection and try again.' };
  }

  if (!response.ok) {
    return { ok: false, code: 'EXCHANGE_FAILED', message: `OpenRouter refused to complete sign-in (HTTP ${response.status}). Try again, or paste a key instead.` };
  }

  let key = '';
  try {
    ({ key } = await response.json());
  } catch {
    return { ok: false, code: 'EXCHANGE_FAILED', message: 'OpenRouter returned an unreadable response. Try again, or paste a key instead.' };
  }
  if (!key) {
    return { ok: false, code: 'EXCHANGE_FAILED', message: 'OpenRouter completed sign-in but returned no key. Try again, or paste a key instead.' };
  }

  // Stored exactly like a pasted key: same place, same protections. Signing in
  // changes how the key is obtained, not where it lives.
  const settings = await loadSettings();
  settings.provider = 'openrouter';
  settings.keys = { ...settings.keys, openrouter: key };
  await chrome.storage.local.set({ settings });

  return { ok: true, message: 'Signed in to OpenRouter.' };
}

/** Model list doubles as the key test: it is authenticated and costs nothing. */
async function listModels(settings) {
  const adapter = getProvider(settings.provider);
  const key = activeKey(settings);
  if (!key) return { ok: false, code: 'NO_KEY', message: 'Add an API key first.' };

  let url;
  let headers;
  try {
    ({ url, headers } = adapter.buildModelsRequest({
      key,
      baseUrl: activeBaseUrl(settings, adapter),
      requiresBaseUrl: !!adapter.requiresBaseUrl,
    }));
  } catch (err) {
    // A missing or unusable base URL is a settings problem, not a crash: the
    // options page's Test button must say what to fix.
    return { ok: false, ...toUserError(err) };
  }
  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    return {
      ok: false,
      code: 'NETWORK',
      message: 'Could not reach the provider. Check the URL and your connection.',
    };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const { code, message } = adapter.parseError(response.status, body);
    return { ok: false, code, message };
  }
  // A base URL pointing at an HTML page answers 200 with a body json() rejects.
  let json;
  try {
    json = await response.json();
  } catch {
    return {
      ok: false,
      code: 'bad_response',
      message: 'That URL answered, but not with JSON. Check the base URL in the extension options — it should be the API root, not a web page.',
    };
  }
  if (!json || typeof json !== 'object') {
    // A `null` body parses fine and would otherwise be reported as "Key works — 0 models".
    return {
      ok: false,
      code: 'bad_response',
      message: 'That URL answered, but with nothing that looks like a model list. Check the base URL in the extension options.',
    };
  }
  const models = adapter.parseModels(json);
  return { ok: true, models };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own pages and content scripts may ask. Without this,
  // any other installed extension can call getSettings or point listModels at
  // a host of its choosing and have the worker attach the user's real key.
  if (sender.id !== chrome.runtime.id) return false;

  // Every path below MUST answer. A throw here — a custom base URL returning
  // HTML instead of JSON, a stale provider id — would otherwise leave the
  // options page's Test button spinning forever with no way to find out why.
  const answer = (payload) => {
    try {
      sendResponse(payload);
    } catch {
      // Requester navigated away mid-call. Nothing to deliver to.
    }
  };

  (async () => {
    switch (msg?.type) {
      case 'getSettings': {
        // The content script runs on youtube.com and needs none of the secrets.
        // Hand it the two fields it actually uses and nothing else.
        const s = await loadSettings();
        // `hasKey` is a boolean, never the key: it lets the panel say "set this
        // up first" before the user clicks and waits through a transcript fetch
        // only to be told at the end.
        answer({
          autoRun: s.autoRun,
          openPanel: s.openPanel,
          defaultMode: s.defaultMode,
          lang: s.lang,
          hasKey: !!activeKey(s),
        });
        return;
      }
      case 'listModels': {
        // Settings come from storage, never from the message: a caller-supplied
        // baseUrl would redirect a request that carries the stored key.
        answer(await listModels(await loadSettings()));
        return;
      }
      case 'testKey': {
        const settings = await loadSettings();
        const result = await listModels(settings);
        answer(
          result.ok
            ? { ok: true, message: `Key works — ${result.models.length} models available.`, models: result.models }
            : result
        );
        return;
      }
      case 'signIn':
        answer(await signInWithOpenRouter());
        return;
      case 'openOptions':
        chrome.runtime.openOptionsPage();
        answer({ ok: true });
        return;
      default:
        answer({ ok: false, code: 'UNKNOWN_MESSAGE', message: 'Unknown message type.' });
    }
  })().catch((err) => {
    answer({
      ok: false,
      code: 'UNKNOWN',
      message: `The extension hit an unexpected error: ${err?.message || err}`,
    });
  });
  return true; // keep the channel open for the async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// A bring-your-own-key extension does nothing at all until a key is entered, so
// the settings page IS the onboarding. Open it once, on first install only —
// not on every update, which would be obnoxious.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// Session storage is trusted-contexts-only by default, so every read and write
// from the content script would reject and the summary cache would silently
// fall back to an in-memory map that dies on each page load — exactly the
// lifetime it exists to survive.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {
    // Older Chrome without setAccessLevel: the panel's in-memory fallback holds.
  });
