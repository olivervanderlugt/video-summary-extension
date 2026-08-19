import { PROVIDERS } from '../providers/index.js';

const DEFAULTS = {
  provider: 'anthropic',
  keys: { anthropic: '', openai: '', gemini: '', compatible: '' },
  model: '',
  baseUrl: '',
  lang: 'en',
  defaultMode: 'detailed',
  autoRun: false,
  maxTokens: 4000,
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
  defaultMode: $('defaultMode'),
  modeHint: $('modeHint'),
  maxTokens: $('maxTokens'),
  autoRun: $('autoRun'),
  wipeBtn: $('wipeBtn'),
  wipeConfirm: $('wipeConfirm'),
  wipeCancel: $('wipeCancel'),
  wipeMsg: $('wipeMsg'),
  saved: $('saved'),
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

let savedTimer = null;
async function save() {
  await chrome.storage.local.set({ settings });
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
    note.textContent = settings.keys[id] ? 'key saved' : 'no key yet';

    label.append(radio, name, note);
    el.providerList.append(label);
  }
}

function renderProviderFields() {
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
  // on screen has to be persisted before asking.
  await save();
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
    saveSoon();
  });

  el.toggleKey.addEventListener('click', () => {
    const show = el.key.type === 'password';
    el.key.type = show ? 'text' : 'password';
    el.toggleKey.textContent = show ? 'Hide' : 'Show';
    el.toggleKey.setAttribute('aria-pressed', String(show));
  });

  el.testBtn.addEventListener('click', async () => {
    await save();
    el.testBtn.disabled = true;
    say(el.testResult, 'Testing…', 'busy');
    const res = await ask({ type: 'testKey' });
    el.testBtn.disabled = false;
    if (res && res.ok) {
      const n = Array.isArray(res.models) ? res.models.length : null;
      say(el.testResult, res.message || res.note || (n !== null ? `Key works — ${n} models available.` : 'Key works.'), 'ok');
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
    saveSoon();
  });

  el.modelCustom.addEventListener('input', () => {
    const custom = el.modelCustom.value.trim();
    settings.model = custom || el.model.value;
    saveSoon();
  });

  el.refreshModels.addEventListener('click', () => refreshModels());

  el.lang.addEventListener('input', () => {
    settings.lang = el.lang.value.trim().toLowerCase();
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

function fill() {
  el.lang.value = settings.lang;
  el.maxTokens.value = settings.maxTokens;
  el.autoRun.checked = !!settings.autoRun;
  el.defaultMode.value = settings.defaultMode;
}

async function init() {
  await load();
  renderProviders();
  await fillModes();
  fill();
  renderProviderFields();
  wire();
  refreshModels({ silent: true });
}

init();
