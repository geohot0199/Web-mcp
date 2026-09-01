/*
 * Orbit connection — the keyless bridge to Orbit's planning model.
 *
 * There is no API key concept in this module: no key input, no provider
 * account, no model name, no endpoint form, and no authorization header is
 * ever read, held, or sent. Connecting is a single click and stores no
 * secret. The connection lives in memory for the current page lifetime and is
 * cleared on refresh/close or by Orbit's "Wipe all data" action.
 *
 * The local deterministic agent remains the safety layer. When the Orbit
 * connection is active, an open-ended creative request may be handed to the
 * planning model to produce a proposal; the result is still normalised,
 * staged, and approved by the human before anything mutates the scene. If the
 * connection is unavailable, the studio falls back to the deterministic
 * planner and keeps working.
 */

export const ORBIT_CONNECTION = Object.freeze({
  label: 'Orbit connection',
  short: 'Orbit',
  model: 'orbit-planner',
  endpoint: 'https://connection.orbit.studio/v1/plan'
});

let connected = false;

export function isOrbitConnected() {
  return connected;
}

export function getOrbitConnection() {
  return { connected, ...ORBIT_CONNECTION };
}

export function connectOrbit() {
  connected = true;
  return getOrbitConnection();
}

export function disconnectOrbit() {
  connected = false;
  return getOrbitConnection();
}

function planningRequestBody({ system, user }) {
  const messages = [];
  const systemText = String(system || '').trim();
  const userText = String(user || '').trim();
  if (systemText) messages.push({ role: 'system', content: systemText });
  messages.push({ role: 'user', content: userText });
  return {
    model: ORBIT_CONNECTION.model,
    messages,
    temperature: 0.4,
    max_tokens: 1600
  };
}

function responseText(payload) {
  if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text.trim();
  return String(payload?.choices?.[0]?.message?.content || '').trim();
}

/*
 * Keyless by design: the request carries a JSON body only. No key, token, or
 * Authorization header is attached under any circumstance.
 */
export async function orbitPlanningRequest({ system = '', user = '', signal } = {}) {
  const response = await fetch(ORBIT_CONNECTION.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(planningRequestBody({ system, user })),
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
    throw new Error(`Orbit connection error ${response.status}: ${detail}`.slice(0, 260));
  }

  const text = responseText(payload);
  if (!text) throw new Error('The Orbit connection returned an empty response.');
  return text;
}

export async function testOrbitConnection({ signal } = {}) {
  try {
    const reply = await orbitPlanningRequest({
      system: 'You are a connection test. Reply with exactly: ok',
      user: 'ping',
      signal
    });
    const status = /ok/i.test(reply) ? 'Orbit connection verified.' : `Connected (reply: ${reply.slice(0, 60)}).`;
    return { ok: true, message: status };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
