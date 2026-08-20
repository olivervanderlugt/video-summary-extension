import { PROVIDERS } from '../providers/index.js';

const DEFAULTS = {
  provider: 'openrouter', // sign-in beats hunting for an API key
  keys: { anthropic: '', openai: '', gemini: '', openrouter: '', compatible: '' },
  model: '',
  baseUrl: '',
  lang: 'en',
  defaultMode: 'detailed',
  autoRun: false,
  openPanel: false,
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
  signInView: $('signInView'),
  keyView: $('keyView'),
  toKeyView: $('toKeyView'),
  toSignInView: $('toSignInView'),
  signInBtn: $('signInBtn'),
  signInResult: $('signInResult'),
  defaultMode: $('defaultMode'),
  modeHint: $('modeHint'),
  maxTokens: $('maxTokens'),
  autoRun: $('autoRun'),
  openPanel: $('openPanel'),
  wipeBtn: $('wipeBtn'),
  wipeConfirm: $('wipeConfirm'),
  wipeCancel: $('wipeCancel'),
  wipeMsg: $('wipeMsg'),
  saved: $('saved'),
  connState: $('connState'),
  tour: $('tour'),
  tourStep: $('tourStep'),
  tourTotal: $('tourTotal'),
  tourTitle: $('tourTitle'),
  tourBody: $('tourBody'),
  tourSkip: $('tourSkip'),
  tourNext: $('tourNext'),
};

// The fields that hold a half-finished value between keystrokes. Selects and
// checkboxes commit the moment they change, so they have nothing to lose.
const DRAFT_FIELDS = [el.key, el.baseUrl, el.modelCustom, el.maxTokens];

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
  if (!PROVIDERS[settings.provider]) {
    settings.provider = DEFAULTS.provider;
    await persist();   // otherwise the content script keeps reading the bogus id
  }
}

/**
 * Storage can change under this page: a second options tab, or the worker
 * writing a key after sign-in. The module-level `settings` would otherwise go
 * stale and the next edit would write the old copy back over it.
 */
function watchStorage() {
  chrome.storage.onChanged?.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    // Our own writes come back through here too; they carry what we already have.
    if (JSON.stringify(changes.settings.newValue) === JSON.stringify(settings)) return;

    // Whatever the user is in the middle of typing is newer than the write that
    // just arrived, so it survives the re-render and is put back into settings.
    // The view is left alone for the same reason: a second tab must not throw
    // someone out of the form they are filling in.
    const typing = DRAFT_FIELDS.includes(document.activeElement) ? document.activeElement : null;
    const draft = typing ? typing.value : null;

    await load();
    renderProviders();
    fill();
    renderProviderFields();
    if (!typing) showKeyView(!adapter().supportsSignIn);
    if (typing && typing.value !== draft) {
      typing.value = draft;
      typing.dispatchEvent(new Event('input', { bubbles: true }));
    }
    refreshModels({ silent: true });
  });
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

/** Only the providers you bring your own key to. OpenRouter is the sign-in
    view's whole job, so listing it here as a fifth equal would undo that. */
function keyProviders() {
  return Object.entries(PROVIDERS).filter(([, p]) => !p.supportsSignIn);
}

/** Which provider the key view shows. It follows the stored one, unless that
    one signs in rather than taking a key — then the view offers a default. */
function keyViewProvider() {
  if (!adapter().supportsSignIn) return settings.provider;
  const withKey = keyProviders().find(([id]) => (settings.keys[id] || '').trim());
  return (withKey || keyProviders()[0])[0];
}

/** The provider the sign-in view acts on. */
function signInProvider() {
  const found = Object.entries(PROVIDERS).find(([, p]) => p.supportsSignIn);
  return found ? found[0] : DEFAULTS.provider;
}

/**
 * The one place a provider change is written down. `model` is a single global
 * string, and model ids belong to the provider that minted them —
 * `claude-opus-5` on Anthropic is `anthropic/claude-opus-5` on OpenRouter — so
 * carrying one across is a request the new provider will reject. Dropping it
 * lets refreshModels fall back to that provider's default.
 */
function commitProvider(id) {
  if (settings.provider === id) return false;
  settings.provider = id;
  settings.model = '';
  return true;
}

/** Opening the key view only reveals it. Typing in it is the choice, and this
    is where that choice becomes the stored provider. */
function commitKeyProvider() {
  return commitProvider(keyViewProvider());
}

function renderProviders() {
  el.providerList.replaceChildren();
  for (const [id, p] of keyProviders()) {
    const label = document.createElement('label');
    label.className = 'provider';
    label.htmlFor = 'provider-' + id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'provider';
    radio.id = 'provider-' + id;
    radio.value = id;
    radio.checked = id === keyViewProvider();
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      commitProvider(id);
      renderProviderFields();
      save();
      refreshModels({ silent: true });
    });

    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = p.label || id;

    label.append(radio, name);
    el.providerList.append(label);
  }
}

/**
 * Two entrances, one panel. Sign-in is the default; the key path is disclosed
 * on request, and is what someone with a stored non-OpenRouter provider lands
 * on. The view is derived from the setting, never remembered separately.
 */
function showKeyView(on) {
  el.keyView.hidden = !on;
  el.signInView.hidden = !!on;
  updateState(false);
}

function renderProviderFields() {
  const shown = keyViewProvider();
  const p = PROVIDERS[shown];
  el.keyProviderName.textContent = p.label || shown;
  el.key.value = settings.keys[shown] || '';
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
    el.testBtn.disabled = false;
  }

  const radio = el.providerList.querySelector(`input[value="${CSS.escape(shown)}"]`);
  if (radio) radio.checked = true;

  say(el.testResult, '');
  updateState(false);
}

/** One status, in one place: the badge on the panel heading. */
function updateState(testPassed) {
  const onSignIn = !el.signInView.hidden;
  // The sign-in view reports on the provider it would sign you in to, not on
  // whatever is stored: looking at it commits nothing.
  const hasKey = !!(settings.keys[onSignIn ? signInProvider() : keyViewProvider()] || '').trim();
  el.connState.textContent = testPassed
    ? 'tested, works'
    : hasKey
      ? (onSignIn ? 'signed in' : 'key saved')
      : (onSignIn ? 'not connected' : 'no key yet');
  el.connState.className = 'state' + (hasKey ? ' good' : '');
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

  // Nothing to ask the provider with yet. Show the built-in list quietly rather
  // than warning someone about a fetch they never asked for. A provider you
  // point at your own server is exempt: a local one usually wants no key, and
  // there is no built-in list to fall back to.
  if (!(settings.keys[settings.provider] || '').trim() && !p.requiresBaseUrl) {
    renderModelOptions(p.fallbackModels || [], selected);
    syncModelInputs(selected);
    say(el.modelMsg, '');
    return;
  }

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
        // The worker's messages are whole sentences and already end in a
        // full stop; appending another produced "first.. Type".
        : `No model list available — ${String(why).replace(/\.\s*$/, '')}. Type the model name below.`,
      'warn'
    );
  }
  syncModelInputs(selected);
}

function syncModelInputs(selected) {
  const inList = Array.from(el.model.options).some((o) => o.value === selected);
  el.model.value = inList ? selected : (el.model.options[0] ? el.model.options[0].value : '');
  el.modelCustom.value = inList ? '' : (selected || '');
}

function validateBaseUrl() {
  const r = checkBaseUrl(el.baseUrl.value);
  if (r.error) {
    // Including the empty case. Saying nothing there left the page showing a
    // tested, working key above a field with no server in it.
    say(el.baseUrlMsg, r.error, 'err');
    el.grantBtn.hidden = true;
    el.testBtn.disabled = true;
    // An earlier pass described a different server. It does not describe this.
    say(el.testResult, '');
    updateState(false);
    return null;
  }
  el.testBtn.disabled = false;
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
    commitKeyProvider();
    settings.keys[settings.provider] = el.key.value.trim();
    say(el.testResult, '');   // the key that passed is not the key in the field
    updateState(false);
    saveSoon();
  });

  el.toggleKey.addEventListener('click', () => {
    const show = el.key.type === 'password';
    el.key.type = show ? 'text' : 'password';
    el.toggleKey.textContent = show ? 'Hide' : 'Show';
    el.toggleKey.setAttribute('aria-pressed', String(show));
  });

  // A disclosure, and nothing more: the stored provider is left alone until the
  // user picks a radio or types a key.
  el.toKeyView.addEventListener('click', () => {
    renderProviderFields();
    showKeyView(true);
    el.key.focus();
  });

  // Also a disclosure and nothing more. Looking at the sign-in view must not
  // leave someone with a working key on a provider they have no key for;
  // pressing Sign in is the interaction that commits.
  el.toSignInView.addEventListener('click', () => {
    showKeyView(false);
    el.signInBtn.focus();
  });

  el.signInBtn.addEventListener('click', async () => {
    el.signInBtn.disabled = true;
    say(el.signInResult, 'Opening the sign-in window…', 'busy');
    const res = await ask({ type: 'signIn' });
    el.signInBtn.disabled = false;
    if (res && res.ok) {
      const previous = settings.provider;
      await load();          // the worker wrote the key; re-read rather than guess
      // The worker sets the provider but leaves `model` alone, so the commit
      // happens here, against what was stored before the sign-in.
      settings.provider = signInProvider();
      if (settings.provider !== previous) settings.model = '';
      await persist();
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
    commitKeyProvider();
    await persist();
    el.testBtn.disabled = true;
    say(el.testResult, 'Testing…', 'busy');
    const res = await ask({ type: 'testKey' });
    el.testBtn.disabled = false;
    if (res && res.ok) {
      const n = Array.isArray(res.models) ? res.models.length : null;
      say(el.testResult, res.message || res.note || (n !== null ? `Key works — ${n} models available.` : 'Key works.'), 'ok');
      updateState(true);
    } else {
      say(el.testResult, (res && res.message) || 'The test failed and the worker gave no reason.', 'err');
    }
  });

  el.baseUrl.addEventListener('input', () => {
    commitKeyProvider();
    const origin = validateBaseUrl();
    const value = el.baseUrl.value.trim();
    // Keep the last URL that parsed rather than store a rejected one: that is
    // how the worker ended up with a blank base URL and a default of
    // api.openai.com. An emptied field is not a rejected URL though — it is
    // someone taking the server out, and leaving the old host stored would keep
    // sending their key and the transcript to it.
    if (!origin && value) return;
    settings.baseUrl = value;
    saveSoon();
  });

  el.baseUrl.addEventListener('change', async () => {
    const origin = validateBaseUrl();
    if (origin) {
      await requestOrigin(origin);
    } else if (!el.baseUrl.value.trim() && grantedOrigin) {
      // Cleared: hand back the permission the old host still holds.
      await releaseOrigin(grantedOrigin);
      grantedOrigin = null;
    }
  });

  el.grantBtn.addEventListener('click', async () => {
    const origin = validateBaseUrl();
    if (origin) await requestOrigin(origin);
  });

  el.model.addEventListener('change', () => {
    settings.model = el.model.value;
    el.modelCustom.value = '';
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

  // min and max on the input do nothing outside a form, so out-of-range typing
  // used to vanish on blur. Clamp it and put the number that was kept on screen.
  el.maxTokens.addEventListener('change', () => {
    const n = Math.round(Number(el.maxTokens.value));
    const kept = Number.isFinite(n) && n > 0
      ? Math.min(32000, Math.max(256, n))
      : settings.maxTokens;
    el.maxTokens.value = kept;
    if (kept === settings.maxTokens) return;
    settings.maxTokens = kept;
    save();
  });

  el.openPanel.addEventListener('change', () => {
    settings.openPanel = el.openPanel.checked;
    save();
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
    showKeyView(false);   // back to a fresh install: sign-in is the whole page
    refreshModels({ silent: true });
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
  el.openPanel.checked = !!settings.openPanel;
  el.defaultMode.value = settings.defaultMode;
}

async function init() {
  await load();
  renderProviders();
  renderLanguages();
  await fillModes();
  fill();
  renderProviderFields();
  // Someone who already configured a key provider lands on their own setup;
  // everyone else gets the sign-in.
  showKeyView(!adapter().supportsSignIn);
  wire();
  watchStorage();
  wireTips();
  wireTour();
  maybeStartTour();
  refreshModels({ silent: true });
}

/* ---------- explanations behind the "i" ---------- */

/*
 * Where there is a pointer, hover and keyboard focus reveal the text and CSS
 * does all of it — a click toggle there would only fight the hover. Where
 * there is no hover, tapping is the only way in, so that is the one case that
 * gets a handler. Either way the text is tied to its control with
 * aria-describedby, so a screen reader never has to find the icon.
 */
function wireTips() {
  const tips = Array.from(document.querySelectorAll('.info'), (btn) => ({
    btn,
    tip: $(btn.getAttribute('aria-controls')),
  })).filter((t) => t.tip);

  const closeAll = () => {
    for (const { btn, tip } of tips) {
      tip.classList.remove('open');
      if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
    }
  };

  // CSS handles anything that hovers, including a touchscreen laptop, which
  // reports hover: hover with a coarse pointer. What is left has only taps.
  if (!window.matchMedia('(hover: hover)').matches) {
    for (const { btn, tip } of tips) {
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        const open = !tip.classList.contains('open');
        closeAll();
        tip.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
      });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeAll();
    // A hover-revealed tip is held open by focus; letting go of it closes it.
    if (document.activeElement && document.activeElement.classList.contains('info')) {
      document.activeElement.blur();
    }
  });
}

/* ---------- first-visit walkthrough ---------- */

/* Three coach marks, shown once. They ride on top of the page rather than in
   front of it: no overlay, no focus trap, nothing disabled. Someone who ignores
   them entirely can still use every control underneath. */
const TOUR_STEPS = [
  {
    target: 'connectPanel',
    title: 'Start by signing in',
    body: 'One press and OpenRouter gives this extension a key of its own \u2014 good for Claude, GPT and Gemini. Brought a key from somewhere else? The link underneath opens that path.',
  },
  {
    target: 'modelSection',
    title: 'Then pick a model',
    body: 'The list is fetched from whichever provider you connected. Anything on it works; the default is a sensible one.',
  },
  {
    target: 'prefsSection',
    title: 'The rest is optional',
    body: 'Caption language is the one worth a look: it decides which transcript is fetched, and so which language the summary comes back in. The rest have working defaults.',
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
  // The "i" is first in DOM order in every one of these sections, and it is not
  // what the step was about. A docked step has no target, so fall back to the
  // first control on the page that is actually on screen.
  const scope = returnTo || document;
  const focusable = Array.from(
    scope.querySelectorAll('input, select, button:not(.info), a[href], summary')
  ).find((node) => node.offsetParent !== null);
  if (focusable) focusable.focus();
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
