// Lets src/options/options.html render in an ordinary tab.
//
// The options page is an extension page: it talks to the service worker over
// chrome.runtime and reads chrome.storage. None of that exists on a plain
// origin, so the page would die on its first call. This stands in for both,
// with a fake provider that answers a model list and a key test, so the page
// can be looked at and clicked through without installing anything.
//
// Loaded by dev/serve.py, which injects it ahead of the page's own script.
// It is never part of the extension.

(() => {
  const store = {};

  const FAKE_MODELS = {
    anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    openrouter: [
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5',
      'google/gemini-2.5-flash',
    ],
    compatible: ['llama-3.3-70b', 'qwen2.5-coder'],
  };

  const activeKey = (s) => (s?.keys?.[s.provider] || '').trim();

  async function respond(msg) {
    const s = store.settings || {};
    console.log('[shim] message', msg.type);

    if (msg.type === 'getSettings') {
      return { autoRun: !!s.autoRun, defaultMode: s.defaultMode, lang: s.lang, hasKey: !!activeKey(s) };
    }

    if (msg.type === 'listModels' || msg.type === 'testKey') {
      if (!activeKey(s)) return { ok: false, code: 'NO_KEY', message: 'Add an API key first.' };
      const models = FAKE_MODELS[s.provider] || [];
      return msg.type === 'testKey'
        ? { ok: true, message: `Key works — ${models.length} models available.`, models }
        : { ok: true, models };
    }

    if (msg.type === 'signIn') {
      await new Promise((r) => setTimeout(r, 600)); // pretend the popup happened
      if (window.__shimSignInFails) return { ok: false, code: 'CANCELLED', message: 'Sign-in cancelled.' };
      store.settings = {
        ...s,
        provider: 'openrouter',
        keys: { ...(s.keys || {}), openrouter: 'sk-or-v1-FAKE-HARNESS-KEY' },
      };
      return { ok: true, message: 'Signed in to OpenRouter.' };
    }

    if (msg.type === 'openOptions') return { ok: true };
    return { ok: false, code: 'UNKNOWN_MESSAGE', message: 'Unknown message type.' };
  }

  window.chrome = {
    runtime: {
      id: 'options-harness',
      lastError: null,
      openOptionsPage: () => console.log('[shim] openOptionsPage'),
      // Chrome supports both a promise and a callback. options.js uses the
      // callback form, and a promise-only stub hangs the page silently.
      sendMessage: (msg, callback) => {
        const result = respond(msg);
        if (typeof callback === 'function') {
          result.then(callback);
          return undefined;
        }
        return result;
      },
    },

    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj) => Object.assign(store, obj),
        clear: async () => Object.keys(store).forEach((k) => delete store[k]),
      },
      session: { setAccessLevel: async () => {} },
    },

    permissions: {
      request: async ({ origins }) => {
        console.log('[shim] permissions.request', origins);
        return true;
      },
      remove: async ({ origins }) => {
        console.log('[shim] permissions.remove', origins);
        return true;
      },
      contains: async () => true,
    },
  };

  // Handy while looking at the page: back to a first-run state.
  window.__shimReset = () => {
    Object.keys(store).forEach((k) => delete store[k]);
    location.reload();
  };
})();
