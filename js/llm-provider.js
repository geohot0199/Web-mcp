/*
 * Orbit's optional bring-your-own-model bridge.
 *
 * This module is intentionally small and dependency-free. It only holds the key
 * in memory for the current page lifetime; the key is never written to
 * localStorage, Sentry, analytics, or anywhere on disk. Closing or refreshing the
 * tab clears it automatically, and Orbit's "Wipe all data and the key" action
 * clears it immediately.
 *
 * The local deterministic agent remains the safety layer. When a key is
 * configured, an open-ended creative request may be handed to the user's model
 * to produce a proposal; the result is still normalised, staged, and approved by
 * the human before anything mutates the scene.
 */

export const LLM_PROVIDERS = {
  openai: {
    label: 'OpenAI-compatible',
    short: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1'
  },
  anthropic: {
    label: 'Anthropic Claude',
    short: 'Claude',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultBaseUrl: 'https://api.anthropic.com/v1/messages'
  },
  gemini: {
    label: 'Google Gemini',
    short: 'Gemini',
    defaultModel: 'gemini-2.5-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta'
  },
  custom: {
    label: 'Custom / local proxy',
    short: 'Custom',
    defaultModel: 'llama-3.1-70b-instruct',
    defaultBaseUrl: ''
  }
};

export const DEFAULT_PROVIDER = 'openai';

let activeConfig = normaliseLlmConfig(null);

export function normaliseLlmConfig(value = null) {
  const source = value || {};
  const provider = Object.prototype.hasOwnProperty.call(LLM_PROVIDERS, source.provider)
    ? source.provider
    : DEFAULT_PROVIDER;
  const defaults = LLM_PROVIDERS[provider];
  return {
    provider,
    apiKey: String(source.apiKey || '').trim(),
    model: String(source.model || defaults.defaultModel).trim(),
    baseUrl: String(source.baseUrl || defaults.defaultBaseUrl).trim()
  };
}

export function setLlmConfig(value) {
  activeConfig = normaliseLlmConfig(value);
  return getLlmConfig();
}

export function getLlmConfig() {
  return { ...activeConfig };
}

export function clearLlmConfig() {
  activeConfig = normaliseLlmConfig(null);
  return getLlmConfig();
}

export function isLlmConfigured(config = activeConfig) {
  return Boolean(config && config.apiKey && config.model);
}

export function providerLabel(provider = activeConfig.provider) {
  return LLM_PROVIDERS[provider]?.label || LLM_PROVIDERS[DEFAULT_PROVIDER].label;
}

export function defaultModelFor(provider = DEFAULT_PROVIDER) {
  return LLM_PROVIDERS[provider]?.defaultModel || LLM_PROVIDERS[DEFAULT_PROVIDER].defaultModel;
}

export function defaultBaseUrlFor(provider = DEFAULT_PROVIDER) {
  return LLM_PROVIDERS[provider]?.defaultBaseUrl || '';
}

export function validateLlmConfig(config = activeConfig) {
  const clean = normaliseLlmConfig(config);
  if (!clean.apiKey) return { ok: false, message: 'Enter your API key first. It stays in this tab only.' };
  if (!clean.model) return { ok: false, message: 'Enter the model name you want to use.' };
  if ((clean.provider === 'custom' || clean.provider === 'openai') && !clean.baseUrl) {
    return { ok: false, message: `Choose a ${LLM_PROVIDERS[clean.provider].label} endpoint (or use the default).` };
  }
  return { ok: true, config: clean, message: 'Configuration looks ready.' };
}

function joinUrl(base, path) {
  const withoutSlash = String(base || '').trim().replace(/\/+$/, '');
  return withoutSlash ? `${withoutSlash}/${path}` : path;
}

export function resolveEndpoint(config) {
  const clean = normaliseLlmConfig(config);
  const model = encodeURIComponent(clean.model);
  if (clean.provider === 'anthropic') {
    return clean.baseUrl || LLM_PROVIDERS.anthropic.defaultBaseUrl;
  }
  if (clean.provider === 'gemini') {
    const base = clean.baseUrl || LLM_PROVIDERS.gemini.defaultBaseUrl;
    return `${base.replace(/\/+$/, '')}/models/${model}:generateContent`;
  }
  const base = clean.baseUrl || LLM_PROVIDERS.openai.defaultBaseUrl;
  return /\/chat\/completions(?:\?.*)?$/.test(base) ? base : joinUrl(base, 'chat/completions');
}

function buildBody(config, { system, user }) {
  const clean = normaliseLlmConfig(config);
  const systemText = String(system || '').trim();
  const userText = String(user || '').trim();
  if (clean.provider === 'anthropic') {
    const body = {
      model: clean.model,
      max_tokens: 1600,
      temperature: 0.4,
      messages: [{ role: 'user', content: userText }]
    };
    if (systemText) body.system = systemText;
    return body;
  }
  if (clean.provider === 'gemini') {
    const content = systemText ? `${systemText}\n\n${userText}` : userText;
    return {
      contents: [{ role: 'user', parts: [{ text: content }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1600 }
    };
  }
  const messages = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  messages.push({ role: 'user', content: userText });
  return {
    model: clean.model,
    messages,
    temperature: 0.4,
    max_tokens: 1600
  };
}

function buildHeaders(config) {
  const clean = normaliseLlmConfig(config);
  const headers = { 'Content-Type': 'application/json' };
  if (clean.provider === 'anthropic') {
    headers['x-api-key'] = clean.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (clean.provider === 'gemini') {
    headers['x-goog-api-key'] = clean.apiKey;
  } else {
    headers.Authorization = `Bearer ${clean.apiKey}`;
  }
  return headers;
}

function responseTextFor(provider, payload) {
  if (provider === 'anthropic') {
    return (payload?.content || [])
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text || ''))
      .join('')
      .trim();
  }
  if (provider === 'gemini') {
    return (payload?.candidates?.[0]?.content?.parts || [])
      .map((part) => String(part.text || ''))
      .join('')
      .trim();
  }
  return String(payload?.choices?.[0]?.message?.content || '').trim();
}

export async function chatCompletion(config, { system = '', user = '', signal } = {}) {
  const clean = normaliseLlmConfig(config);
  const validation = validateLlmConfig(clean);
  if (!validation.ok) throw new Error(validation.message);

  const url = resolveEndpoint(clean);
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(clean),
    body: JSON.stringify(buildBody(clean, { system, user })),
    signal
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.error?.message
      || payload?.message
      || (typeof payload === 'string' ? payload : null)
      || `${response.status} ${response.statusText}`;
    throw new Error(`${providerLabel(clean.provider)} error ${response.status}: ${detail}`.slice(0, 260));
  }

  const text = responseTextFor(clean.provider, payload);
  if (!text) throw new Error(`${providerLabel(clean.provider)} returned an empty response.`);
  return text;
}

export async function testLlmConnection(config = activeConfig, { signal } = {}) {
  const clean = normaliseLlmConfig(config);
  try {
    const reply = await chatCompletion(clean, {
      system: 'You are a connection test. Reply with exactly: ok',
      user: 'ping',
      signal
    });
    const status = /ok/i.test(reply) ? 'Connection verified.' : `Connected (reply: ${reply.slice(0, 60)}).`;
    return { ok: true, message: status };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
