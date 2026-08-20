import { PROVIDERS } from '../providers/index.js';

const DEFAULTS = {
  provider: 'openrouter', // sign-in beats hunting for an API key
  keys: { anthropic: '', openai: '', gemini: '', openrouter: '', compatible: '' },
  model: '',
  baseUrl: '',
  lang: 'en',
  defaultMode: 'detailed',
  autoRun: false,
  maxTokens: 4000,
  // Set once the first-visit walkthrough has been finished or skipped.
  onboardingDone: false,
};

// prompt.js is the source of truth for modes; if it is unavailable the page must
// still load, so fall back to the modes named in the design spec.
const FALLBACK_MODES = {
  brief: 'Brief',
  detailed: 'Detailed',
  bullets: 'Bullets',
  eli5: 'Explain simply',
  quotes: 'Key quotes',
};

const $ = (id) => document.getElementById(id);
// Endonym first, because someone looking for their own language scans for the
// word they call it, not for the English name.
const CAPTION_LANGUAGES = [
  ['', 'Automatic — whatever the video offers'],
  ['en', 'English'],
  ['nl', 'Nederlands — Dutch'],
  ['de', 'Deutsch — German'],
  ['fr', 'Français — French'],
  ['es', 'Español — Spanish'],
  ['pt', 'Português — Portuguese'],
  ['it', 'Italiano — Italian'],
  ['pl', 'Polski — Polish'],
  ['tr', 'Türkçe — Turkish'],
  ['ru', 'Русский — Russian'],
  ['uk', 'Українська — Ukrainian'],
  ['sv', 'Svenska — Swedish'],
  ['da', 'Dansk — Danish'],
  ['no', 'Norsk — Norwegian'],
  ['fi', 'Suomi — Finnish'],
  ['cs', 'Čeština — Czech'],
  ['el', 'Ελληνικά — Greek'],
  ['he', 'עברית — Hebrew'],
  ['ar', 'العربية — Arabic'],
  ['hi', 'हिन्दी — Hindi'],
  ['id', 'Bahasa Indonesia — Indonesian'],
  ['vi', 'Tiếng Việt — Vietnamese'],
  ['th', 'ไทย — Thai'],
  ['ja', '日本語 — Japanese'],
  ['ko', '한국어 — Korean'],
  ['zh', '中文 — Chinese'],
];

const el = {
  providerList: $('providerList'),
  key: $('key'),
  toggleKey: $('toggleKey'),
  keyProviderName: $('keyProviderName'),
  keysLink: $('keysLink'),
  testBtn: $('testBtn'),
  testResult: $('testResult'),
  baseUrlSection: $('baseUrlSection'),
  baseUrl: $('baseUrl'),
  baseUrlMsg: $('baseUrlMsg'),
  grantBtn: $('grantBtn'),
  model: $('model'),
  modelCustom: $('modelCustom'),
  refreshModels: $('refreshModels'),
  modelMsg: $('modelMsg'),
  lang: $('lang'),
  signInBlock: $('signInBlock'),
  signInBtn: $('signInBtn'),
  signInResult: $('signInResult'),
  defaultMode: $('defaultMode'),
  modeHint: $('modeHint'),
  maxTokens: $('maxTokens'),
  autoRun: $('autoRun'),
  wipeBtn: $('wipeBtn'),
  wipeConfirm: $('wipeConfirm'),
  wipeCancel: $('wipeCancel'),
  wipeMsg: $('wipeMsg'),
  saved: $('saved'),
  stepProvider: $('stepProvider'),
  stepKey: $('stepKey'),
  stepModel: $('stepModel'),
  providerState: $('providerState'),
  keyState: $('keyState'),
  tour: $('tour'),
  tourStep: $('tourStep'),
  tourTotal: $('tourTotal'),
  tourTitle: $('tourTitle'),
  tourBody: $('tourBody'),
  tourSkip: $('tourSkip'),
  tourNext: $('tourNext'),
};

let settings = { ...DEFAULTS };
// Origin the stored base URL currently holds a host permission for.
let grantedOrigin = null;

/* ---------- helpers ---------- */

function say(node, text, kind) {
  node.textContent = text || '';
  node.className = 'result' + (text && kind ? ' ' + kind : '');
}

function adapter() {
  return PROVIDERS[settings.provider] || PROVIDERS.anthropic;
}

/** Ask the service worker something; never throws. */
function ask(message) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          done({ ok: false, message: chrome.runtime.lastError.message });
        } else if (!res) {
          done({ ok: false, message: 'The extension background worker did not answer. Reload the extension from chrome://extensions and try again.' });
        } else {
          done(res);
        }
      });
    } catch (e) {
      done({ ok: false, message: String(e && e.message ? e.message : e) });
    }
  });
}

/** Parse a base URL; returns {origin, local} or {error}. */
function checkBaseUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return { error: 'Enter the base URL of your OpenAI-compatible server.' };
  let u;
  try {
    u = new URL(value);
  } catch {
    return { error: 'That is not a URL. It needs a scheme and a host, like https://api.example.com/v1.' };
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol === 'https:') return { origin: u.origin, local: false };
  if (u.protocol === 'http:' && local) return { origin: u.origin, local: true };
  if (u.protocol === 'http:') return { error: 'Plain http: is only allowed for localhost. Use https: for anything on the network — an http: URL sends your API key in the clear.' };
  return { error: `Unsupported scheme "${u.protocol}". Use https: (or http: for a local server).` };
}

/* ---------- storage ---------- */

async function load() {
  const stored = await chrome.storage.local.get('settings');
  const s = stored && stored.settings ? stored.settings : {};
  settings = { ...DEFAULTS, ...s, keys: { ...DEFAULTS.keys, ...(s.keys || {}) } };
  // Remember which origin the stored base URL already holds a grant for, so
  // changing it later hands that grant back instead of leaving it live.
  try {
    grantedOrigin = settings.baseUrl ? new URL(settings.baseUrl).origin : null;
  } catch {
    grantedOrigin = null;
  }
  if (!PROVIDERS[settings.provider]) settings.provider = DEFAULTS.provider;
}

/**
 * Write settings without saying anything. Everything the page does behind the
 * user's back — persisting before asking the worker for models, stamping the
 * onboarding flag — goes through this. Only an actual edit calls save().
 */
async function persist() {
  await chrome.storage.local.set({ settings });
}

let savedTimer = null;
async function save() {
  await persist();
  el.saved.textContent = 'Saved';
  el.saved.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.saved.classList.remove('show'), 1600);
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

/* ---------- rendering ---------- */

function renderProviders() {
  el.providerList.replaceChildren();
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const label = document.createElement('label');
    label.className = 'provider';
    label.htmlFor = 'provider-' + id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'provider';
    radio.id = 'provider-' + id;
    radio.value = id;
    radio.checked = id === settings.provider;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      settings.provider = id;
      renderProviderFields();
      save();
      refreshModels({ silent: true });
    });

    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = p.label || id;

    const note = document.createElement('span');
    note.className = 'provider-note';
    // Signing in has no key to have saved yet, and "no key yet" reads as a
    // chore. Say what the user actually has to do instead.
    note.textContent = settings.keys[id]
      ? p.supportsSignIn
        ? 'signed in'
        : 'key saved'
      : p.supportsSignIn
        ? 'sign in — no key needed'
        : 'needs an API key';

    if (p.supportsSignIn) {
      label.classList.add('provider-recommended');
      const flag = document.createElement('span');
      flag.className = 'provider-flag';
      flag.textContent = 'Easiest';
      label.append(radio, name, flag, note);
      el.providerList.append(label);
      continue;
    }

    label.append(radio, name, note);
    el.providerList.append(label);
  }
}

/** Only OpenRouter can do this today, so the block is driven by the adapter. */
function renderSignIn() {
  const p = adapter();
  el.signInBlock.hidden = !p.supportsSignIn;
  if (p.supportsSignIn) el.signInBtn.textContent = `Sign in with ${p.label.split(' (')[0]}`;
}

function renderProviderFields() {
  renderSignIn();
  const p = adapter();
  el.keyProviderName.textContent = p.label || settings.provider;
  el.key.value = settings.keys[settings.provider] || '';
  el.key.placeholder = p.keyPlaceholder || 'API key';

  if (p.keysUrl) {
    el.keysLink.href = p.keysUrl;
    el.keysLink.textContent = 'Get a key from ' + new URL(p.keysUrl).hostname;
    el.keysLink.hidden = false;
  } else {
    el.keysLink.hidden = true;
  }

  el.baseUrlSection.hidden = !p.requiresBaseUrl;
  if (p.requiresBaseUrl) {
    el.baseUrl.value = settings.baseUrl || '';
    validateBaseUrl();
  } else {
    say(el.baseUrlMsg, '');
    el.grantBtn.hidden = true;
  }

  // Mark which providers already hold a key.
  for (const [id, node] of Object.entries(providerNotes())) {
    node.textContent = settings.keys[id] ? 'key saved' : 'no key yet';
  }
  say(el.testResult, '');
  updateSteps(false);
}

/** Short name for the pill — the parenthetical in the label is noise there. */
function shortLabel(p, id) {
  return (p.label || id).split(' (')[0];
}

/**
 * The numbered rail is the page's map of "what still needs doing", so it has to
 * follow the real state rather than be decoration.
 */
function updateSteps(testPassed) {
  const p = adapter();
  // A provider is always selected, so step one is only ever informational.
  el.stepProvider.classList.add('done');
  el.providerState.textContent = shortLabel(p, settings.provider);
  el.providerState.className = 'state good';

  const hasKey = !!(settings.keys[settings.provider] || '').trim();
  el.stepKey.classList.toggle('done', hasKey);
  el.keyState.textContent = testPassed ? 'tested, works' : (hasKey ? 'key saved' : 'no key yet');
  el.keyState.className = 'state' + (hasKey ? ' good' : '');

  // Only a step you can actually have reached: a model is meaningless without a key.
  el.stepModel.classList.toggle('done', hasKey && !!(settings.model || p.defaultModel));
}

function providerNotes() {
  const out = {};
  for (const label of el.providerList.querySelectorAll('.provider')) {
    const id = label.querySelector('input').value;
    out[id] = label.querySelector('.provider-note');
  }
  return out;
}

function renderModelOptions(models, selected) {
  el.model.replaceChildren();
  const list = models.slice();
  if (selected && !list.includes(selected)) list.unshift(selected);
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no models available —';
    el.model.append(opt);
    return;
  }
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === selected) opt.selected = true;
    el.model.append(opt);
  }
  if (!selected) el.model.selectedIndex = 0;
}

async function refreshModels({ silent } = {}) {
  const p = adapter();
  const selected = settings.model || p.defaultModel || '';
  if (!silent) say(el.modelMsg, 'Loading models…', 'busy');

  // The worker reads settings from storage, never from the message, so what is
  // on screen has to be persisted before asking. Silently: init() calls this,
  // and a page load is not an edit.
  await persist();
  const res = await ask({ type: 'listModels' });
  if (res && res.ok && Array.isArray(res.models) && res.models.length) {
    renderModelOptions(res.models, selected);
    say(el.modelMsg, `${res.models.length} models available.`, 'ok');
  } else {
    const fallback = p.fallbackModels || [];
    renderModelOptions(fallback, selected);
    const why = (res && res.message) || 'the model list could not be fetched';
    say(
      el.modelMsg,
      fallback.length
        ? `Showing a built-in list, which may be out of date — ${why}`
        : `No model list available — ${why}. Type the model name below.`,
      'warn'
    );
  }
  syncModelInputs(selected);
  updateSteps();
}

function syncModelInputs(selected) {
  const inList = Array.from(el.model.options).some((o) => o.value === selected);
  el.model.value = inList ? selected : (el.model.options[0] ? el.model.options[0].value : '');
  el.modelCustom.value = inList ? '' : (selected || '');
}

function validateBaseUrl() {
  const r = checkBaseUrl(el.baseUrl.value);
  if (r.error) {
    say(el.baseUrlMsg, el.baseUrl.value.trim() ? r.error : '', 'err');
    el.grantBtn.hidden = true;
    return null;
  }
  if (r.local) {
    say(el.baseUrlMsg, 'Local server over plain http — fine on your own machine, but your API key travels unencrypted, so never point this at a remote host.', 'warn');
  } else {
    say(el.baseUrlMsg, '');
  }
  return r.origin;
}

/**
 * Hand back the permission for an origin the user has moved away from. A grant
 * outlives the setting that asked for it, so without this a base URL typed once
 * stays a permitted destination forever.
 */
async function releaseOrigin(origin) {
  if (!origin) return;
  const pattern = origin.replace(/\/+$/, '') + '/*';
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    // Not granted, or not removable (it is one of the manifest's own). Fine.
  }
}

async function requestOrigin(origin) {
  const pattern = origin.replace(/\/+$/, '') + '/*';
  // Drop the previous grant first; the user is pointing somewhere else now.
  if (grantedOrigin && grantedOrigin !== origin) await releaseOrigin(grantedOrigin);
  grantedOrigin = origin;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (e) {
    say(el.baseUrlMsg, `Chrome refused the permission request for ${pattern}: ${e && e.message ? e.message : e}`, 'err');
    el.grantBtn.hidden = false;
    return false;
  }
  if (granted) {
    say(el.baseUrlMsg, `Access to ${origin} granted.`, 'ok');
    el.grantBtn.hidden = true;
  } else {
    say(el.baseUrlMsg, `You declined access to ${origin}. Nothing will work until you grant it — the extension cannot reach a server Chrome has not allowed it to contact.`, 'err');
    el.grantBtn.hidden = false;
  }
  return granted;
}

/* ---------- wiring ---------- */

function wire() {
  el.key.addEventListener('input', () => {
    settings.keys[settings.provider] = el.key.value.trim();
    const notes = providerNotes();
    if (notes[settings.provider]) notes[settings.provider].textContent = settings.keys[settings.provider] ? 'key saved' : 'no key yet';
    updateSteps(false);
    saveSoon();
  });

  el.toggleKey.addEventListener('click', () => {
    const show = el.key.type === 'password';
    el.key.type = show ? 'text' : 'password';
    el.toggleKey.textContent = show ? 'Hide' : 'Show';
    el.toggleKey.setAttribute('aria-pressed', String(show));
  });

  el.signInBtn.addEventListener('click', async () => {
    el.signInBtn.disabled = true;
    say(el.signInResult, 'Opening the sign-in window…', 'busy');
    const res = await ask({ type: 'signIn' });
    el.signInBtn.disabled = false;
    if (res && res.ok) {
      await load();          // the worker wrote the key; re-read rather than guess
      renderProviders();
      renderProviderFields();
      fill();
      say(el.signInResult, res.message || 'Signed in.', 'ok');
      refreshModels({ silent: true });
    } else {
      say(el.signInResult, (res && res.message) || 'Sign-in did not complete.', res?.code === 'CANCELLED' ? 'warn' : 'err');
    }
  });

  el.testBtn.addEventListener('click', async () => {
    await persist();
    el.testBtn.disabled = true;
    say(el.testResult, 'Testing…', 'busy');
    const res = await ask({ type: 'testKey' });
    el.testBtn.disabled = false;
    if (res && res.ok) {
      const n = Array.isArray(res.models) ? res.models.length : null;
      say(el.testResult, res.message || res.note || (n !== null ? `Key works — ${n} models available.` : 'Key works.'), 'ok');
      updateSteps(true);
    } else {
      say(el.testResult, (res && res.message) || 'The test failed and the worker gave no reason.', 'err');
    }
  });

  el.baseUrl.addEventListener('input', () => {
    settings.baseUrl = el.baseUrl.value.trim();
    validateBaseUrl();
    saveSoon();
  });

  el.baseUrl.addEventListener('change', async () => {
    const origin = validateBaseUrl();
    if (origin) await requestOrigin(origin);
  });

  el.grantBtn.addEventListener('click', async () => {
    const origin = validateBaseUrl();
    if (origin) await requestOrigin(origin);
  });

  el.model.addEventListener('change', () => {
    settings.model = el.model.value;
    el.modelCustom.value = '';
    updateSteps();
    saveSoon();
  });

  el.modelCustom.addEventListener('input', () => {
    const custom = el.modelCustom.value.trim();
    settings.model = custom || el.model.value;
    saveSoon();
  });

  el.refreshModels.addEventListener('click', () => refreshModels());

  el.lang.addEventListener('change', () => {
    settings.lang = el.lang.value;
    saveSoon();
  });

  el.defaultMode.addEventListener('change', () => {
    settings.defaultMode = el.defaultMode.value;
    showModeHint();
    saveSoon();
  });

  el.maxTokens.addEventListener('input', () => {
    const n = Number(el.maxTokens.value);
    if (Number.isFinite(n) && n >= 256 && n <= 32000) {
      settings.maxTokens = Math.round(n);
      saveSoon();
    }
  });

  el.autoRun.addEventListener('change', () => {
    settings.autoRun = el.autoRun.checked;
    save();
  });

  el.wipeBtn.addEventListener('click', () => {
    el.wipeBtn.hidden = true;
    el.wipeConfirm.hidden = false;
    el.wipeCancel.hidden = false;
    say(el.wipeMsg, 'This removes every key and setting from this browser. It cannot be undone.', 'warn');
  });

  el.wipeCancel.addEventListener('click', () => {
    el.wipeBtn.hidden = false;
    el.wipeConfirm.hidden = true;
    el.wipeCancel.hidden = true;
    say(el.wipeMsg, '');
  });

  el.wipeConfirm.addEventListener('click', async () => {
    await chrome.storage.local.clear();
    settings = { ...DEFAULTS, keys: { ...DEFAULTS.keys } };
    el.wipeBtn.hidden = false;
    el.wipeConfirm.hidden = true;
    el.wipeCancel.hidden = true;
    fill();
    renderProviders();
    renderProviderFields();
    say(el.wipeMsg, 'Everything stored by this extension has been deleted.', 'ok');
    endTour();
  });
}

async function fillModes() {
  let modes = FALLBACK_MODES;
  try {
    const mod = await import('../lib/prompt.js');
    if (mod && mod.MODES) modes = mod.MODES;
  } catch {
    // prompt.js unavailable — the fallback list keeps the page usable.
  }
  el.defaultMode.replaceChildren();
  modeHints = {};
  for (const [id, value] of Object.entries(modes)) {
    if (value && typeof value === 'object' && value.hint) modeHints[id] = value.hint;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = (value && typeof value === 'object' && value.label) || (typeof value === 'string' ? value : id);
    el.defaultMode.append(opt);
  }
  el.defaultMode.value = settings.defaultMode;
  if (!el.defaultMode.value && el.defaultMode.options.length) el.defaultMode.selectedIndex = 0;
  showModeHint();
}

let modeHints = {};
function showModeHint() {
  el.modeHint.textContent = modeHints[el.defaultMode.value] || '';
}

/** Built once. fill() runs on every save, and must not stack duplicates. */
function renderLanguages() {
  el.lang.textContent = '';
  for (const [code, label] of CAPTION_LANGUAGES) el.lang.append(new Option(label, code));
}

function fill() {
  // A stored code that is not on the list (set before this was a select, or by
  // hand) still has to be selectable, or saving the page would silently change it.
  if (settings.lang && !CAPTION_LANGUAGES.some(([code]) => code === settings.lang)) {
    el.lang.append(new Option(`${settings.lang} — saved earlier`, settings.lang));
  }
  el.lang.value = settings.lang || '';
  el.maxTokens.value = settings.maxTokens;
  el.autoRun.checked = !!settings.autoRun;
  el.defaultMode.value = settings.defaultMode;
}

async function init() {
  await load();
  renderProviders();
  renderLanguages();
  await fillModes();
  fill();
  renderProviderFields();
  wire();
  wireTour();
  maybeStartTour();
  refreshModels({ silent: true });
}

/* ---------- first-visit walkthrough ---------- */

/* Three coach marks, shown once. They ride on top of the page rather than in
   front of it: no overlay, no focus trap, nothing disabled. Someone who ignores
   them entirely can still use every control underneath. */
const TOUR_STEPS = [
  {
    target: 'stepProvider',
    title: 'Start by picking a provider',
    body: 'Five to choose from. OpenRouter is the shortest route — it lets you sign in instead of pasting a key, and mints one for this extension itself.',
  },
  {
    target: 'stepKey',
    title: 'Add your key, then press Test',
    body: 'Paste the key, or press "Sign in with OpenRouter" if you chose that. Then press "Test this key" — it tells you in plain words whether it worked.',
  },
  {
    target: 'prefsCard',
    title: 'The rest is optional',
    body: 'Language, summary style, length and the rest all have working defaults. Change any of it now or later; nothing here is permanent.',
  },
];

let tourIndex = -1;
let tourTarget = null;

function tourActive() {
  return tourIndex >= 0;
}

function placeTour(node) {
  el.tour.classList.toggle('floating', !node);
  if (!node) return;
  const rect = node.getBoundingClientRect();
  // Document coordinates, so the card stays put while the page scrolls.
  const top = rect.bottom + window.scrollY + 14;
  const width = el.tour.offsetWidth || 340;
  const maxLeft = Math.max(12, document.documentElement.clientWidth - width - 12);
  const left = Math.min(Math.max(rect.left + window.scrollX, 12), maxLeft);
  el.tour.style.setProperty('--tour-x', left + 'px');
  el.tour.style.setProperty('--tour-y', top + 'px');
}

function showTourStep(i) {
  const step = TOUR_STEPS[i];
  if (!step) return endTour();
  tourIndex = i;

  if (tourTarget) tourTarget.classList.remove('tour-target');
  // A missing or hidden target must not stop the walkthrough; it just loses its
  // anchor and docks at the bottom of the window instead.
  const node = $(step.target);
  tourTarget = node && !node.hidden ? node : null;
  if (tourTarget) tourTarget.classList.add('tour-target');

  el.tourStep.textContent = String(i + 1);
  el.tourTotal.textContent = String(TOUR_STEPS.length);
  el.tourTitle.textContent = step.title;
  el.tourBody.textContent = step.body;
  el.tourNext.textContent = i === TOUR_STEPS.length - 1 ? 'Done' : 'Next';
  el.tour.hidden = false;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (tourTarget) tourTarget.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  placeTour(tourTarget);
  el.tour.focus();
}

function endTour() {
  if (!tourActive()) return;
  tourIndex = -1;
  if (tourTarget) tourTarget.classList.remove('tour-target');
  const returnTo = tourTarget;
  tourTarget = null;
  el.tour.hidden = true;
  // Focus was inside the card that just vanished; hand it back to the page.
  if (returnTo) {
    const focusable = returnTo.querySelector('input, select, button, a[href], summary');
    if (focusable) focusable.focus();
  }
  if (!settings.onboardingDone) {
    settings.onboardingDone = true;
    persist();   // silent: finishing the tour is not an edit the user made
  }
}

function wireTour() {
  el.tourNext.addEventListener('click', () => showTourStep(tourIndex + 1));
  el.tourSkip.addEventListener('click', endTour);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tourActive()) {
      e.preventDefault();
      endTour();
    }
  });
  window.addEventListener('resize', () => { if (tourActive()) placeTour(tourTarget); });
}

/** First visit, unless ?tour= says otherwise (1 forces it, 0 suppresses it). */
function maybeStartTour() {
  const forced = new URLSearchParams(location.search).get('tour');
  if (forced === '0') return;
  if (forced !== '1' && settings.onboardingDone) return;
  showTourStep(0);
}

init();
