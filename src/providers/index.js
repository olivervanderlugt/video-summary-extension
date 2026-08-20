import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';

// Same wire format as openai — derived, never copied, so there is one implementation.
const compatible = {
  ...openai,
  id: 'compatible',
  label: 'OpenAI-compatible (custom URL)',
  origin: null, // host permission is requested at runtime for whatever the user enters
  requiresBaseUrl: true,
  defaultModel: '',
  fallbackModels: [],
  keysUrl: null,
  keyPlaceholder: 'API key (leave blank for a local server)',
};

// Also the openai wire format, but first-class rather than "custom URL": it is
// the only provider of the four that offers a real sign-in, so it should not be
// buried behind a field asking for a base URL.
const openrouter = {
  ...openai,
  id: 'openrouter',
  label: 'OpenRouter (sign in — no key to copy)',
  origin: 'https://openrouter.ai/*',
  requiresBaseUrl: false,
  fixedBaseUrl: 'https://openrouter.ai/api/v1',
  supportsSignIn: true,
  defaultModel: 'anthropic/claude-sonnet-5',
  fallbackModels: [
    'anthropic/claude-opus-5',
    'anthropic/claude-sonnet-5',
    'openai/gpt-5',
    'google/gemini-2.5-flash',
  ],
  keysUrl: 'https://openrouter.ai/keys',
  keyPlaceholder: 'sk-or-... (or just press Sign in)',
};

export const PROVIDERS = { anthropic, openai, gemini, openrouter, compatible };

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Unknown AI provider "${id}" — pick one of: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  return provider;
}
