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

export const PROVIDERS = { anthropic, openai, gemini, compatible };

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Unknown AI provider "${id}" — pick one of: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  return provider;
}
