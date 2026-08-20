// Isolated world. Classic script (MV3 content scripts cannot be modules), so no
// import/export anywhere in this file.
//
// This file owns every pixel and nothing else. It has no API key, no provider
// knowledge, no json3 parser, no markdown renderer. It relays:
//
//   click
//     -> postMessage main world: 'transcript'      -> { meta, tracks }
//     -> port 'begin' { meta, tracks }             -> worker picks the track
//     <- port 'fetchTrack' { baseUrl, trackInfo }
//     -> postMessage main world: 'fetchTrack'      -> { json3 }
//     -> port 'run' { json3, trackInfo, mode }
//     <- port 'status' / 'render' / 'done' / 'error'
//
// The only string that ever reaches innerHTML is the HTML the worker's own
// escaping renderer produced (src/lib/markdown.js). Everything else is
// createElement + textContent.
(() => {
  'use strict';
  if (window.__vseContentLoaded) return;
  window.__vseContentLoaded = true;

  // ------------------------------------------------------------- constants

  const PAGE_TIMEOUT = 20000; // main-world RPC; a reply that never comes must not hang the panel
  const MOUNT_BUDGET = 20; // ~10s of retries before the button falls back to the panel header
  const MOUNT_INTERVAL = 500;

  // Ids and labels copied verbatim from MODES in src/lib/prompt.js, which is the
  // source of truth for what each mode actually does. A classic content script
  // cannot import that module, so this list has to be kept in step by hand.
  const MODES = [
    { id: 'brief', label: 'Brief' },
    { id: 'detailed', label: 'Detailed' },
    { id: 'bullets', label: 'Bullets' },
    { id: 'eli5', label: 'Explain simply' },
    { id: 'quotes', label: 'Key quotes' },
  ];

  // One sentence and a fix, never a stack trace. `calm: true` means "this is a
  // fact about the video, not a malfunction" — it must not read as an error.
  // The worker's own `message` is preferred as the body when it sends one.
  const ERRORS = {
    NO_CAPTIONS: {
      calm: true,
      title: 'No captions on this video',
      body: 'There is no caption track to read, so there is nothing to summarize. Videos with captions — auto-generated ones count — work fine.',
    },
    LIVE: {
      calm: true,
      title: 'Live stream',
      body: 'Live streams have no finished caption track yet. Try again once the recording is published.',
    },
    TRACK_EMPTY: {
      title: 'The caption track came back empty',
      body: 'YouTube listed a caption track but returned nothing for it. Try again, or reload the page.',
    },
    NO_TRANSCRIPT: {
      title: 'YouTube would not hand over the transcript',
      body: 'This video has captions, but YouTube refused to serve their text to this session. Reload the page — or open the video’s own transcript panel once — and try again.',
    },
    NO_PLAYER: { title: "Couldn't read the video data", body: 'Reload the page and try again.' },
    PAGE_TIMEOUT: { title: 'The page stopped responding', body: 'Reload the page and try again.' },
    // Provider adapters emit lowercase codes; a refusal is not a fault to fix.
    unknown: { title: 'Something went wrong', body: 'Try again.' },
    blocked: {
      title: 'The provider declined this video',
      calm: true,
      body: 'Its safety filter refused the transcript. A different provider or model usually works.',
    },
    NEEDS_PLAY: {
      title: 'Press play first',
      calm: true,
      body: 'YouTube only releases caption text while the video is playing. Start it, give it a second, then summarize.',
    },
    NO_KEY: { title: 'No API key configured', action: 'options', body: 'Add your provider key in the extension settings.' },
    NO_BASE_URL: {
      title: 'No server address configured',
      action: 'options',
      body: 'The OpenAI-compatible provider needs the address of your server. Nothing is sent until you enter one.',
    },
    bad_response: {
      title: "The provider sent something unreadable",
      body: 'That address answered, but not with what an AI provider sends. Check the server address in settings.',
    },
    // These five are the codes the provider adapters emit verbatim. They are
    // lowercase on purpose — matching them is what puts the "Open settings"
    // button under a rejected key, which is the error where it is the whole fix.
    auth: { title: 'The provider rejected your key', action: 'options', body: 'Check the key in settings.' },
    rate_limit: { title: 'Rate limited by the provider', body: 'Wait a moment and run it again.' },
    bad_request: { title: 'The provider rejected the request', body: 'This video may be too long for the selected model.' },
    model: { title: 'Unknown model', action: 'options', body: 'Pick a different model in settings.' },
    server: { title: 'The provider is having trouble', body: 'Wait a moment and try again.' },
    NETWORK: { title: "Couldn't reach the provider", body: 'Check your connection and try again.' },
    EMPTY: { title: 'The provider returned nothing', body: 'Run it again — this is usually transient.' },
    DISCONNECTED: { title: 'The extension restarted mid-run', body: 'Chrome shut the background worker down. Run it again.' },
    UNKNOWN: { title: 'Something went wrong', body: 'Try again.' },
  };

  // ----------------------------------------------------------------- state

  const state = {
    videoId: null,
    mode: 'brief',
    expanded: false,
    askOpen: false,
    running: false,
    runSeq: 0,
    runVideoId: null,
    asking: false,
    port: null,
    begunFor: null, // videoId this port has already sent 'begin' for
    summarisedFor: null, // videoId with a completed summary in the worker (Ask needs one)
    text: '', // cumulative plain text from the worker (used for copy + fallback paint)
    html: '', // cumulative worker-rendered, already-escaped HTML
    transcript: null, // { videoId, meta, tracks, json3, trackInfo }
    thread: [], // [{role:'user'|'assistant', content}]
    autoRun: false,
  };

  const el = {}; // mounted nodes, rebuilt whenever YouTube replaces the DOM


  // ------------------------------------------------------------- utilities

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'vse-icon');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    }
    return svg;
  }

  const ICONS = {
    sparkle: [
      'M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z',
      'M18.4 15.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
    ],
    copy: ['M9.5 8.5h9v11h-9z', 'M6.5 15.5h-2v-11h9v2'],
    gear: [
      'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z',
      'M19.4 13.1a7.6 7.6 0 000-2.2l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 00-1.9-1.1L15.1 4h-3.6l-.3 2.2c-.68.25-1.31.62-1.86 1.1l-2-.8-1.8 3.1 1.7 1.3a7.6 7.6 0 000 2.2l-1.7 1.3 1.8 3.1 2-.8c.55.48 1.18.85 1.86 1.1l.3 2.2h3.6l.3-2.2c.68-.25 1.31-.62 1.86-1.1l2 .8 1.8-3.1z',
    ],
    chat: ['M20 12a7 7 0 01-7 7H8.5L4.5 22v-4.2A7 7 0 019 5h4a7 7 0 017 7z'],
    close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    send: ['M4.5 12l15-7.5-5.6 15-2.4-5.6z'],
  };

  function iconButton(name, label, cls) {
    const b = node('button', `vse-iconbtn ${cls || ''}`.trim());
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(ICONS[name]));
    return b;
  }

  function textButton(label, onClick, cls) {
    const b = node('button', `vse-textbtn ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const currentVideoId = () => new URLSearchParams(location.search).get('v');
  const isWatch = () => location.pathname === '/watch' && !!currentVideoId();

  function mkError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  // --------------------------------------------------- main-world RPC

  let reqSeq = 0;

  function pageCall(type, extra, timeoutMs) {
    return new Promise((resolve, reject) => {
      // Unguessable, so a page script cannot answer blind. It can still read
      // the outgoing request off the shared window and race a reply, so the
      // transcript this channel returns is treated as page-controlled either
      // way — it is wrapped as untrusted data before the model ever sees it.
      const reqId = `vse-${(self.crypto?.randomUUID?.() || `${Date.now()}-${++reqSeq}`)}`;
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, mkError('PAGE_TIMEOUT', 'The page did not respond.')),
        timeoutMs || PAGE_TIMEOUT
      );
      function onMessage(event) {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.source !== 'vse-page' || d.reqId !== reqId) return;
        if (d.ok) finish(resolve, d.data);
        else finish(reject, mkError((d.error && d.error.code) || 'UNKNOWN', (d.error && d.error.message) || ''));
      }
      window.addEventListener('message', onMessage);
      try {
        window.postMessage(Object.assign({ source: 'vse', reqId, type }, extra || {}), location.origin);
      } catch {
        finish(reject, mkError('UNKNOWN', 'Could not talk to the page.'));
      }
    });
  }

  // --------------------------------------------------- worker one-shots

  // MV3 returns a promise; both callers swallow errors, so the throw when the
  // worker is gone needs no wrapping.
  const sendMessage = (msg) => chrome.runtime.sendMessage(msg);

  const openOptions = () => sendMessage({ type: 'openOptions' }).catch(() => {});

  // ------------------------------------------------------------- cache

  // chrome.storage.session is memory-backed and cleared on browser restart, which
  // is the right lifetime for a summary the user paid for. The Map keeps the
  // feature working when the permission is missing.
  const memCache = new Map();
  const cacheKey = (id, mode) => `vse:sum:${id}:${mode}`;

  function cacheGet(id, mode) {
    const key = cacheKey(id, mode);
    if (memCache.has(key)) return Promise.resolve(memCache.get(key));
    try {
      return chrome.storage.session.get(key).then(
        (o) => (o && o[key]) || null,
        () => null
      );
    } catch {
      return Promise.resolve(null);
    }
  }

  function cacheSet(id, mode, value) {
    const key = cacheKey(id, mode);
    memCache.set(key, value);
    try {
      const p = chrome.storage.session.set({ [key]: value });
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* session storage unavailable — the Map is the cache */
    }
  }

  // ------------------------------------------------------------ button DOM

  function buildButton() {
    const b = node('button', 'vse-button');
    b.type = 'button';
    b.id = 'vse-summarize';
    b.setAttribute('aria-label', 'Summarize this video');
    b.setAttribute('aria-expanded', String(state.expanded));
    b.setAttribute('aria-controls', 'vse-panel');
    b.appendChild(icon(ICONS.sparkle));
    b.appendChild(node('span', 'vse-button-label', 'Summarize'));
    b.addEventListener('click', onSummarizeClick);
    return b;
  }

  // ------------------------------------------------------------- panel DOM

  function buildPanel() {
    const panel = node('section', 'vse-panel vse-collapsed');
    panel.id = 'vse-panel';
    // The panel mounts at the head of #secondary-inner — after the whole primary
    // column in tab order. Focusable so the Summarize click can send you there.
    panel.tabIndex = -1;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Video summary');

    const header = node('div', 'vse-header');
    header.appendChild(node('h2', 'vse-title', 'Summary'));

    const actions = node('div', 'vse-header-actions');

    const modeSelect = node('select', 'vse-modeselect');
    modeSelect.setAttribute('aria-label', 'Summary style');
    for (const m of MODES) {
      const opt = node('option', null, m.label);
      opt.value = m.id;
      modeSelect.appendChild(opt);
    }
    modeSelect.value = state.mode;
    modeSelect.addEventListener('change', onModeChange);

    const askBtn = iconButton('chat', 'Ask a follow-up question', 'vse-askbtn');
    askBtn.setAttribute('aria-pressed', 'false');
    askBtn.addEventListener('click', toggleAsk);

    const copyBtn = iconButton('copy', 'Copy summary', 'vse-copybtn');
    copyBtn.addEventListener('click', onCopy);

    const gearBtn = iconButton('gear', 'Extension settings');
    gearBtn.addEventListener('click', () => openOptions());

    const closeBtn = iconButton('close', 'Close summary panel');
    closeBtn.addEventListener('click', () => collapse());

    actions.append(modeSelect, askBtn, copyBtn, gearBtn, closeBtn);
    header.appendChild(actions);

    const status = node('div', 'vse-status');
    // Notes land here — including the one you get for asking before summarising,
    // which a screen reader would otherwise never announce (it is not aria-live).
    status.setAttribute('role', 'status');
    status.hidden = true;

    const body = node('div', 'vse-body');
    const output = node('div', 'vse-output');
    // polite + aria-busy while streaming: the reader announces the finished
    // summary once, not every token.
    output.setAttribute('aria-live', 'polite');
    output.setAttribute('aria-atomic', 'false');
    output.addEventListener('click', onOutputClick);
    body.appendChild(output);

    const footer = node('div', 'vse-footer');
    footer.hidden = true;
    const thread = node('div', 'vse-thread');
    // Ask answers cite [m:ss] too, and they render here, not in .vse-output.
    thread.addEventListener('click', onOutputClick);
    const form = node('form', 'vse-askform');
    const input = node('textarea', 'vse-input');
    input.rows = 2;
    input.placeholder = 'Ask about this video…';
    input.setAttribute('aria-label', 'Ask a question about this video');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onAsk(e);
      }
    });
    const send = iconButton('send', 'Send question', 'vse-send');
    send.type = 'submit';
    form.append(input, send);
    form.addEventListener('submit', onAsk);
    footer.append(thread, form);

    panel.append(header, status, body, footer);

    Object.assign(el, { panel, header, status, output, footer, thread, input, modeSelect, askBtn, copyBtn });
    return panel;
  }

  const labelFor = (id) => (MODES.find((m) => m.id === id) || MODES[0]).label;

  // A different mode is a different summary: show its cached copy if we have
  // one, otherwise offer to run. Never spend money on a dropdown change.
  function onModeChange(e) {
    state.mode = e.target.value;
    // Pinned for the session: a later settings re-read must not silently pull
    // the mode back to the configured default under the user.
    state.modeChosen = true;
    if (!state.running) showCachedOrIdle();
  }

  // -------------------------------------------------------------- mounting

  let mountTries = 0;
  let mountTimer = null;

  function actionRow() {
    return (
      document.querySelector('#actions ytd-menu-renderer #top-level-buttons-computed') ||
      document.querySelector('#actions #top-level-buttons-computed') ||
      document.querySelector('#top-level-buttons-computed') ||
      document.querySelector('#actions-inner') ||
      document.querySelector('#actions')
    );
  }

  const secondary = () => document.querySelector('#secondary-inner') || document.querySelector('#secondary');

  function mount() {
    if (!isWatch()) return;

    const host = secondary();
    if (host && (!el.panel || !el.panel.isConnected)) {
      const panel = buildPanel();
      host.insertBefore(panel, host.firstChild);
      restoreUiState();
    }

    if (!el.button || !el.button.isConnected) {
      const row = actionRow();
      if (row) {
        el.button = buildButton();
        row.appendChild(el.button);
      } else if (mountTries >= MOUNT_BUDGET && el.panel && el.panel.isConnected) {
        // YouTube moved the action row out from under us. An unusual position for
        // the button beats no button at all.
        el.button = buildButton();
        el.button.classList.add('vse-button-inheader');
        el.header.insertBefore(el.button, el.header.querySelector('.vse-header-actions'));
        expand();
      }
    }

    const incomplete = !el.panel || !el.panel.isConnected || !el.button || !el.button.isConnected;
    if (incomplete && mountTries < MOUNT_BUDGET) {
      mountTries += 1;
      clearTimeout(mountTimer);
      mountTimer = setTimeout(mount, MOUNT_INTERVAL);
    }
  }

  function restoreUiState() {
    if (!el.panel) return;
    el.panel.classList.toggle('vse-collapsed', !state.expanded);
    el.footer.hidden = !state.askOpen;
    el.askBtn.setAttribute('aria-pressed', String(state.askOpen));
    renderThread();
    if (state.expanded) {
      if (state.html || state.text) paint();
      else showCachedOrIdle();
    }
    // A re-mount mid-run rebuilt an empty status bar; without this the spinner
    // and the Stop button are gone until the run happens to send its next status.
    if (state.running) busyStatus(state.asking ? 'Thinking…' : 'Summarizing…');
    syncButtons();
  }

  // YouTube replaces chunks of the watch page at will; re-mount when our nodes
  // vanish. Throttled to a frame so a busy page cannot turn this into a spin.
  let observerQueued = false;
  const observer = new MutationObserver(() => {
    if (observerQueued) return;
    observerQueued = true;
    requestAnimationFrame(() => {
      observerQueued = false;
      if (!isWatch()) return;
      if (!el.panel || !el.panel.isConnected || !el.button || !el.button.isConnected) {
        mountTries = 0;
        mount();
      }
    });
  });

  // ---------------------------------------------------------- panel state

  function expand() {
    state.expanded = true;
    if (el.panel) el.panel.classList.remove('vse-collapsed');
    if (el.button) el.button.setAttribute('aria-expanded', 'true');
    // The user may have just added a key in another tab; re-read before the
    // idle state tells them they still have none.
    refreshSettings().then(() => {
      if (!state.running && !state.html) showCachedOrIdle();
    });
  }

  /** Reads the non-secret slice of settings the panel is allowed to see. */
  async function refreshSettings() {
    try {
      const settings = (await sendMessage({ type: 'getSettings' })) || {};
      state.autoRun = settings.autoRun === true; // never spend money by default
      state.openPanel = settings.openPanel === true;
      state.hasKey = settings.hasKey !== false;
      if (MODES.some((m) => m.id === settings.defaultMode) && !state.modeChosen) {
        state.mode = settings.defaultMode;
      }
    } catch {
      /* worker asleep — leave the last known values in place */
    }
  }

  function collapse() {
    state.expanded = false;
    if (el.panel) el.panel.classList.add('vse-collapsed');
    if (el.button) {
      el.button.setAttribute('aria-expanded', 'false');
      el.button.focus();
    }
  }

  // ------------------------------------------------------------- rendering

  /** The ONLY innerHTML assignment in the UI. `state.html` comes from the worker's
   *  escaping renderer; nothing derived from the page or the model reaches it raw. */
  function paint() {
    const out = el.output;
    if (!out) return;
    if (state.html) out.innerHTML = state.html;
    else if (state.text) out.textContent = state.text; // pre-render fallback: plain text is always safe
    syncButtons();
  }

  function clearOutput() {
    if (!el.output) return;
    el.output.textContent = '';
    el.output.parentNode?.querySelector('.vse-notice')?.remove();
    syncButtons();
  }

  /** Copy with nothing to copy would copy the idle placeholder; Ask with no
   *  summary in the worker can only be answered with a note. Both say so by
   *  being unavailable rather than by failing after the click. */
  function syncButtons() {
    if (el.copyBtn) el.copyBtn.disabled = !(state.html || state.text);
    // Enabled whenever a summary is displayed, including a cached one. A cache
    // hit has no transcript loaded in the worker, so Ask cannot answer — but
    // disabling it here would hide the note that explains why, and would also
    // remove the only way to reopen a collapsed panel without re-running.
    if (el.askBtn) el.askBtn.disabled = !(state.html || state.text);
  }

  function setStatus(kind, text, extras) {
    const s = el.status;
    if (!s) return;
    s.textContent = '';
    s.className = `vse-status vse-status-${kind}`;
    s.hidden = false;
    if (kind === 'busy') s.appendChild(node('span', 'vse-spinner'));
    s.appendChild(node('span', 'vse-status-text', text));
    for (const btn of extras || []) s.appendChild(btn);
  }

  const hideStatus = () => {
    if (el.status) el.status.hidden = true;
  };

  const busyStatus = (text) => setStatus('busy', text, [textButton('Stop', stop, 'vse-stop')]);

  /**
   * A non-fatal note that sits above the summary. Unlike an error it must not
   * clear the output: the partial-transcript warning arrives before the first
   * token and has to survive the whole stream.
   */
  function renderNotice(message) {
    if (!message || !el.output) return;
    let box = el.output.parentNode.querySelector('.vse-notice');
    if (!box) {
      box = node('div', 'vse-notice');
      box.setAttribute('role', 'note');
      el.output.parentNode.insertBefore(box, el.output);
    }
    box.textContent = message;
  }

  function renderError(code, message) {
    const info = ERRORS[code] || ERRORS.unknown || ERRORS.UNKNOWN;
    // A run that ended badly leaves no session in the worker worth reusing. Drop
    // the "already begun" claim so Try again posts a fresh `begin` instead of
    // waiting forever for a `fetchTrack` nobody is going to send.
    state.begunFor = null;
    // The cached transcript is the thing that came back empty; keeping it would
    // make Try again resend it and fail in exactly the same way.
    if (code === 'TRACK_EMPTY' || code === 'NO_TRANSCRIPT') state.transcript = null;

    // Keep whatever already streamed. The reader saw it and paid for it, and
    // the cancel path already preserves it — the error path did the opposite.
    if (state.html || state.text) paint();
    else clearOutput();
    hideStatus();
    const box = node('div', `vse-error${info.calm ? ' vse-error-calm' : ''}`);
    box.setAttribute('role', 'note');
    box.appendChild(node('div', 'vse-error-title', info.title));
    // The worker writes user-facing sentences; prefer its wording when it has one.
    box.appendChild(node('div', 'vse-error-body', (!info.calm && message) || info.body || message || ''));
    const row = node('div', 'vse-error-actions');
    if (info.action === 'options') row.appendChild(textButton('Open settings', () => openOptions(), 'vse-primary'));
    if (!info.calm) row.appendChild(textButton('Try again', () => start({ force: true })));
    if (row.childElementCount) box.appendChild(row);
    el.output.appendChild(box);
  }

  function renderIdle() {
    clearOutput();
    hideStatus();
    const box = node('div', 'vse-idle');

    if (state.hasKey === false) {
      // Say it before the click, not after. Otherwise the first thing a new
      // user experiences is a wait that ends in an error.
      box.appendChild(
        node(
          'p',
          'vse-idle-text',
          'This extension uses your own AI provider key, and there is no key set yet. It takes a minute: pick a provider, paste a key, press Test.'
        )
      );
      box.appendChild(
        textButton('Open settings', () => sendMessage({ type: 'openOptions' }), 'vse-primary')
      );
      el.output.appendChild(box);
      return;
    }

    box.appendChild(
      node('p', 'vse-idle-text', `Summarize this video (${labelFor(state.mode).toLowerCase()}) using your own API key.`)
    );
    box.appendChild(textButton('Summarize', () => start({}), 'vse-primary'));
    el.output.appendChild(box);
  }

  function showCached(hit) {
    state.html = hit.html || '';
    state.text = hit.text || '';
    paint();
    setStatus('cached', 'Cached summary', [textButton('Re-run', () => start({ force: true }))]);
  }

  async function showCachedOrIdle() {
    const id = state.videoId;
    if (!id) return;
    const hit = await cacheGet(id, state.mode);
    if (state.videoId !== id || state.running) return;
    if (hit && (hit.html || hit.text)) showCached(hit);
    else {
      state.html = '';
      state.text = '';
      renderIdle();
    }
  }

  // -------------------------------------------------------------- the port

  function ensurePort() {
    if (state.port) return state.port;
    const port = chrome.runtime.connect({ name: 'vse' });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      state.begunFor = null;
      state.summarisedFor = null;
      if (!state.running) return;
      finishRun();
      if (!state.html && !state.text) renderError('DISCONNECTED');
      else hideStatus();
    });
    state.port = port;
    state.begunFor = null;
    return port;
  }

  const post = (msg) => {
    try {
      ensurePort().postMessage(msg);
      return true;
    } catch {
      finishRun();
      renderError('DISCONNECTED');
      return false;
    }
  };

  /** True while the run that started under `runId` is still the run we care about.
   *  A stale summary rendered under a new video is the worst bug in this file, so
   *  every worker message is gated on this. */
  const fresh = (runId) => state.running && runId === state.runSeq && state.videoId === state.runVideoId;

  function onPortMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    const runId = state.runSeq;
    if (!fresh(runId)) return;

    if (msg.type === 'fetchTrack') {
      onFetchTrack(msg, runId);
    } else if (msg.type === 'status') {
      const detail = msg.detail;
      if (msg.stage === 'section' && detail && detail.total) {
        busyStatus(`Reading section ${detail.index} of ${detail.total}…`);
      } else {
        busyStatus('Summarizing…');
      }
    } else if (msg.type === 'render') {
      if (state.asking) {
        // An answer streams into its own bubble in the thread. Painting it into
        // the panel body would wipe the summary the question is about, and a
        // failed or stopped ask would leave half an answer sitting there.
        const turn = state.thread[state.thread.length - 1];
        if (turn && turn.role === 'assistant') {
          if (typeof msg.text === 'string') turn.content = msg.text;
          if (typeof msg.html === 'string') turn.html = msg.html;
          renderThread();
        }
        hideStatus();
        return;
      }
      if (typeof msg.text === 'string') state.text = msg.text; // cumulative, not a delta
      if (typeof msg.html === 'string') state.html = msg.html;
      if (state.firstPaintPending) {
        state.firstPaintPending = false;
        // Clear the placeholder text only. clearOutput() would also drop the
        // partial-transcript notice, which arrives before the first token and
        // has to stay readable for the whole run.
        if (el.output) el.output.textContent = '';
        hideStatus();
      }
      paint();
    } else if (msg.type === 'warning') {
      renderNotice(msg.message);
    } else if (msg.type === 'done') {
      onDone(msg, runId);
    } else if (msg.type === 'error') {
      // The page found a transcript by another route after the worker had already
      // given up on the caption tracks. Our cues supersede that complaint.
      const t = state.transcript;
      if (t && t.cues && (msg.code === 'NO_CAPTIONS' || msg.code === 'TRACK_EMPTY')) return;
      const wasAsk = state.asking;
      finishRun();
      if (wasAsk) {
        // The summary is still the panel's content; report the failure in the
        // thread instead of replacing what the question was asked about.
        const open = state.thread[state.thread.length - 1];
        if (open && open.role === 'assistant') {
          open.content = msg.message || 'That question failed.';
          open.html = '';
        }
        renderThread();
        restoreSummaryBody();
        setStatus('note', msg.message || 'That question failed.');
        return;
      }
      renderError(msg.code, msg.message);
    }
  }

  /** The worker picked a track; the page fetches it. The page may answer with
   *  raw json3 (strategy "captions") or with ready-made cues (strategies
   *  "panel"/"innertube"); the worker accepts either. This file parses neither. */
  async function onFetchTrack(msg, runId) {
    // `begin` and `run` can be posted back to back when we already hold cues;
    // the worker still answers the `begin` with a fetchTrack. Acting on it would
    // post a second `run`, and the worker cancels the first — a second paid
    // request, and a panel stuck on the aborted run's partial text.
    if (state.runPosted) return;
    const videoId = state.videoId;
    const cached = state.transcript;
    try {
      let payload;
      if (cached && cached.videoId === videoId && cached.baseUrl === msg.baseUrl && (cached.json3 || cached.cues)) {
        payload = cached; // already downloaded for this video — no second network trip
      } else {
        // 40s, not the default 20s: inject's own worst case is 15s timedtext
        // plus the panel and innertube fallbacks, and aborting at 20s throws
        // away a strategy chain that was still working.
        busyStatus('Fetching captions…');
        const res = await pageCall(
          'fetchTrack',
          {
            baseUrl: msg.baseUrl,
            trackInfo: msg.trackInfo,
            videoId: state.videoId,
            duration: state.transcript?.meta?.duration || 0,
          },
          40000
        );
        payload = {
          videoId,
          baseUrl: msg.baseUrl,
          json3: res.json3 || null,
          cues: res.cues || null,
          trackInfo: res.trackInfo || msg.trackInfo || null,
        };
        state.transcript = payload;
      }
      if (!fresh(runId)) return;
      busyStatus('Summarizing…');
      state.runPosted = true;
      post(runMessage(payload));
    } catch (err) {
      if (!fresh(runId)) return;
      finishRun();
      renderError(err.code, err.message);
    }
  }

  const runMessage = (t) =>
    t.cues
      ? { type: 'run', cues: t.cues, trackInfo: t.trackInfo || null, mode: state.runMode }
      : { type: 'run', json3: t.json3, trackInfo: t.trackInfo || null, mode: state.runMode };

  function onDone(msg, runId) {
    if (typeof msg.text === 'string') state.text = msg.text;
    if (typeof msg.html === 'string') state.html = msg.html;
    const wasAsk = state.asking;
    finishRun();

    if (msg.cancelled) {
      paint();
      hideStatus();
      return;
    }
    if (wasAsk) {
      const answer = msg.answer || msg.text || '';
      const open = state.thread[state.thread.length - 1];
      if (open && open.role === 'assistant') {
        open.content = answer;
        open.html = msg.html || '';
      } else {
        state.thread.push({ role: 'assistant', content: answer, html: msg.html || '' });
      }
      renderThread();
      // The panel body keeps the summary; the answer lives in the thread.
      restoreSummaryBody();
      hideStatus();
      return;
    }
    if (!state.html && !state.text) {
      renderError('EMPTY');
      return;
    }
    paint();
    hideStatus();
    state.summarisedFor = state.videoId;
    syncButtons(); // Ask only becomes available once the worker holds a summary
    cacheSet(state.videoId, state.runMode || state.mode, { html: state.html, text: state.text });
  }

  function restoreSummaryBody() {
    const saved = state.summaryView;
    if (!saved) return;
    state.html = saved.html;
    state.text = saved.text;
    paint();
  }

  // -------------------------------------------------------------- run flow

  function onSummarizeClick() {
    const wasExpanded = state.expanded;
    if (!wasExpanded) expand();
    // Keyboard users land in the panel instead of at the far end of tab order.
    // Deliberately here and not in expand(), so auto-run cannot steal focus.
    if (el.panel) el.panel.focus();
    if (!wasExpanded && (state.html || state.text)) {
      paint();
      return;
    }
    if (state.running) return;
    if (state.html || state.text) {
      showCachedOrIdle();
      return;
    }
    start({});
  }

  async function start(opts) {
    const options = opts || {};
    if (state.running) return;
    const videoId = state.videoId;
    if (!videoId) return;
    expand();

    // Before anything costs time: with no key configured, a run can only end in
    // an error after a transcript fetch the user waited through. Say so now.
    // Re-read first, because the key may have been added in another tab.
    await refreshSettings();
    if (state.videoId !== videoId) return;
    if (state.hasKey === false) {
      renderIdle();
      return;
    }

    if (!options.force) {
      const hit = await cacheGet(videoId, state.mode);
      if (state.videoId !== videoId || state.running) return;
      if (hit && (hit.html || hit.text)) {
        showCached(hit);
        state.summaryView = { html: state.html, text: state.text };
        return;
      }
    }

    const runId = ++state.runSeq;
    state.running = true;
    state.runVideoId = videoId;
    state.runPosted = false;
    // Fixed for the whole run. `state.mode` can change under a streaming run
    // when the user opens the mode menu, which would cache the result under the
    // wrong mode and disagree with what was actually requested.
    state.runMode = state.mode;
    state.asking = false;
    state.html = '';
    state.text = '';
    state.firstPaintPending = true;
    if (el.button) el.button.classList.add('vse-busy');
    if (el.output) el.output.setAttribute('aria-busy', 'true');
    // The idle call to action would otherwise sit under the spinner for the whole
    // transcript fetch, full colour and ignoring clicks. Only the box goes — a
    // clearOutput() here would blank the body for the entire Re-run path.
    el.output?.querySelector('.vse-idle')?.remove();
    syncButtons();

    busyStatus('Reading transcript…');

    let head;
    try {
      // 40s, matching fetchTrack: the page-side fallback chain spends 19.74s of
      // fixed timers against the default 20s budget and would be cut off mid-chain.
      head = await pageCall('transcript', { videoId }, 40000);
    } catch (err) {
      // A stale run must never touch the run that replaced it: finishRun() is
      // global and would clear the live run's flag.
      if (!fresh(runId)) return;
      finishRun();
      renderError(err.code, err.message);
      return;
    }
    if (!fresh(runId)) return;

    // The page returns EITHER a caption track list (the worker then picks one and
    // asks us to fetch it) OR, when no track was usable, cues it already scraped.
    const t = state.transcript && state.transcript.videoId === videoId ? state.transcript : { videoId };
    if (Array.isArray(head.cues) && head.cues.length) {
      t.cues = head.cues;
    }
    // Kept so the fetchTrack round trip can tell the page how long the video is:
    // the <video> element's own duration is NaN until its metadata loads.
    if (head.meta) t.meta = head.meta;
    state.transcript = t;

    const port = ensurePort();
    if (!port) return;

    const needBegin = state.begunFor !== videoId;
    if (needBegin) {
      state.begunFor = videoId;
      post({ type: 'begin', meta: head.meta, tracks: head.tracks || [] });
    }

    if (t.cues || (!needBegin && t.json3)) {
      // Nothing left to fetch — a re-run with a different mode, or cues the page
      // scraped without any caption track to choose from.
      busyStatus('Summarizing…');
      state.runPosted = true;
      post(runMessage(t));
    } else if (!needBegin) {
      // Neither message went out and only `begin` can produce a 'fetchTrack', so
      // there is nothing in flight: the panel would spin until a reload.
      // renderError() drops `begunFor`, so Try again starts the session over.
      finishRun();
      renderError('TRACK_EMPTY');
      return;
    }
    // Otherwise: `begin` is out — wait for the worker's 'fetchTrack' reply.
  }

  function finishRun() {
    state.running = false;
    state.asking = false;
    state.firstPaintPending = false;
    if (el.button) el.button.classList.remove('vse-busy');
    if (el.output) el.output.removeAttribute('aria-busy');
  }

  function stop() {
    if (state.port) {
      try {
        state.port.postMessage({ type: 'cancel' });
      } catch {
        /* already gone */
      }
    }
    const wasAsking = state.asking;
    state.runSeq += 1; // invalidates every in-flight guard
    finishRun();
    hideStatus();
    if (wasAsking) {
      // Drop the half-streamed answer bubble and put the summary back.
      const open = state.thread[state.thread.length - 1];
      if (open && open.role === 'assistant' && !open.content) state.thread.pop();
      renderThread();
      restoreSummaryBody();
      return;
    }
    if (!state.html && !state.text) renderIdle();
  }

  // ------------------------------------------------------------------ ask

  function toggleAsk() {
    state.askOpen = !state.askOpen;
    el.footer.hidden = !state.askOpen;
    el.askBtn.setAttribute('aria-pressed', String(state.askOpen));
    if (state.askOpen) {
      expand();
      el.input.focus();
    }
  }

  function onAsk(e) {
    if (e) e.preventDefault();
    const q = el.input.value.trim();
    if (!q || state.running) return;

    if (state.summarisedFor !== state.videoId) {
      // The worker holds the transcript per connection; asking before a summary
      // has nothing to answer from. Say so instead of silently doing nothing.
      setStatus('note', 'This summary came from cache. Press Re-run first, then ask.');
      return;
    }

    el.input.value = '';
    state.summaryView = { html: state.html, text: state.text };
    state.thread.push({ role: 'user', content: q });
    state.thread.push({ role: 'assistant', content: '', html: '' }); // streams into this
    renderThread();

    state.runSeq += 1;
    state.running = true;
    state.asking = true;
    state.runVideoId = state.videoId;
    if (el.button) el.button.classList.add('vse-busy');
    busyStatus('Thinking…');
    post({ type: 'ask', question: q });
  }

  function renderThread() {
    const t = el.thread;
    if (!t) return;
    t.textContent = '';
    for (const turn of state.thread) {
      const row = node('div', `vse-turn vse-turn-${turn.role}`);
      row.appendChild(node('div', 'vse-turn-role', turn.role === 'user' ? 'You' : 'Answer'));
      if (turn.role === 'assistant' && turn.html) {
        const bubble = node('div', 'vse-turn-text vse-output');
        bubble.innerHTML = turn.html; // worker-rendered and escaped, same as the summary
        row.appendChild(bubble);
      } else {
        row.appendChild(node('div', 'vse-turn-text', turn.content));
      }
      t.appendChild(row);
    }
  }

  // ----------------------------------------------------------- timestamps

  function onOutputClick(e) {
    const btn = e.target && e.target.closest && e.target.closest('button.vse-ts');
    if (!btn) return;
    e.preventDefault();
    const seconds = Number(btn.dataset.t);
    if (!Number.isFinite(seconds)) return;
    pageCall('seek', { seconds }, 5000).catch(() => {
      btn.classList.add('vse-ts-failed');
      setTimeout(() => btn.classList.remove('vse-ts-failed'), 1200);
    });
  }

  // ---------------------------------------------------------------- copy

  function onCopy() {
    const text = (state.text || (el.output && el.output.innerText) || '').trim();
    if (!text) return;
    const flash = (ok) => {
      el.copyBtn.classList.add(ok ? 'vse-ok' : 'vse-fail');
      setTimeout(() => el.copyBtn.classList.remove('vse-ok', 'vse-fail'), 1200);
    };
    try {
      navigator.clipboard.writeText(text).then(() => flash(true), () => flash(false));
    } catch {
      flash(false);
    }
  }

  // ------------------------------------------------------- SPA navigation

  function onNavigate() {
    const id = isWatch() ? currentVideoId() : null;

    if (!id) {
      if (state.running) stop();
      dropPort();
      state.videoId = null;
      return;
    }
    if (id === state.videoId) {
      mount(); // same video; YouTube may still have swapped the DOM
      return;
    }

    if (state.running) stop();
    dropPort();
    state.runSeq += 1;
    state.videoId = id;
    state.transcript = null;
    state.thread = [];
    state.text = '';
    state.html = '';
    state.summaryView = null;
    state.summarisedFor = null;
    if (el.thread) el.thread.textContent = '';
    clearOutput();
    hideStatus();

    mountTries = 0;
    mount();
    if (state.expanded) showCachedOrIdle();
    if (state.openPanel && !state.autoRun) expand();
    if (state.autoRun) start({});
  }

  function dropPort() {
    if (!state.port) return;
    try {
      state.port.disconnect();
    } catch {
      /* already gone */
    }
    state.port = null;
    state.begunFor = null;
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-page-data-updated', onNavigate);

  // Backstop: yt-navigate-finish is a YouTube implementation detail and has gone
  // missing before. Polling location is cheap insurance against a stale summary.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    onNavigate();
  }, 800);

  // ------------------------------------------------------------------ boot

  async function boot() {
    await refreshSettings();
    state.videoId = isWatch() ? currentVideoId() : null;
    mount();
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    // Opening the panel costs nothing — it just shows the summary controls
    // without running anything. autoRun is the one that spends money.
    if (state.videoId && state.openPanel && !state.autoRun) expand();
    if (state.videoId && state.autoRun) start({});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
