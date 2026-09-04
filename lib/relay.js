import { SessionError } from './verify.js'

const DEFAULT_BASE_URL = 'https://partners.january.ai'
const MINT_PATH = '/v1.2/auth/client-tokens'
const CREDITS_PATH = '/v1.2/credits'
const UPSTREAM_TIMEOUT_MS = 10_000
const CHECK_TIMEOUT_MS = 5_000
// The two mint failures that are setup problems on the relay's side, not the
// app's. January's status, code and message pass through; the hint is added.
const SETUP_HINTS = {
  401: 'January rejected the API key this relay holds (JANUARY_API_KEY) — not anything your app sent. Create a new key at https://dashboard.january.ai → API keys, put it in .env (or the Vercel environment), and restart the relay.',
  403: 'Client tokens are not enabled for your account yet — turn them on at https://dashboard.january.ai/dashboard/client-tokens — or the API key was issued for the other API version.',
}
// Every scope the v1.2 API defines — the `scopes` field of POST /v1.2/auth/client-tokens.
const ALL_SCOPES = [
  'foods:read',
  'food_analysis:write',
  'food_logs:read',
  'food_logs:write',
  'glucose:read',
  'restaurants:read',
]

/**
 * The relay itself. Three moves, in order:
 *
 *   1. Verify the caller's session with YOUR login system (never January's).
 *   2. Mint a client token for the user that session proved, server-to-server,
 *      with the API key that never leaves this function's environment.
 *   3. Relay January's answer verbatim — status and body — so your app and the
 *      January SDK always see the real error contract, not a paraphrase of it.
 *
 * The relay adds exactly one error of its own: 401 { error: "invalid_session" },
 * which means "re-authenticate the user with your login system". Every January
 * status (403 client tokens disabled, 429 mint limit, 5xx) passes through.
 */
export function createRelayHandler({ env, verify, fetchImpl = fetch }) {
  const apiKey = env.JANUARY_API_KEY?.trim()
  const baseUrl = (env.JANUARY_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  // January requires `scopes` on every mint. TOKEN_SCOPES narrows what a token
  // may do; unset, every scope is requested so the whole SDK can be exercised.
  const scopes = env.TOKEN_SCOPES?.trim()
    ? env.TOKEN_SCOPES.split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)
    : ALL_SCOPES
  const ttlSeconds = env.TOKEN_TTL_SECONDS?.trim()
  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )

  return async function handler(req, res) {
    // Native apps never send an Origin header and need none of this; the
    // allowlist exists so a web build can call the relay during development.
    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-end-user-id')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    // Before the GET branch on purpose: the health check must fail on a
    // misconfigured deployment, not smile through it.
    if (!apiKey) {
      return res.status(500).json({
        error: 'relay_misconfigured',
        message: 'JANUARY_API_KEY is not set in the deployment environment.',
      })
    }
    // Opening the endpoint in a browser is the first thing everyone does —
    // answer with usage instead of an error. Doubles as a health check.
    if (req.method === 'GET') {
      const relayTokenRequired = verify.relayTokenRequired !== false
      return res.status(200).json({
        service: 'january-token-relay',
        status: 'ok',
        relay_token_required: relayTokenRequired,
        usage: relayTokenRequired
          ? "POST here with headers 'Authorization: Bearer <your RELAY_TOKEN>' and 'x-end-user-id: <your id for the user>'."
          : "POST here with header 'x-end-user-id: <your id for the user>'.",
        docs: 'https://github.com/January-ai/january-token-relay',
      })
    }
    if (req.method !== 'POST') {
      return res
        .status(405)
        .json({ error: 'method_not_allowed', message: 'POST to this endpoint.' })
    }

    let endUserId
    try {
      ;({ endUserId } = await verify(req.headers))
    } catch (error) {
      if (error instanceof SessionError) {
        return res.status(401).json({ error: 'invalid_session', message: error.message })
      }
      throw error
    }

    let upstream
    try {
      upstream = await fetchImpl(`${baseUrl}${MINT_PATH}`, {
        method: 'POST',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          // From the verified session — never from the request body.
          end_user_id: endUserId,
          scopes,
          ...(ttlSeconds ? { ttl_seconds: Number(ttlSeconds) } : {}),
        }),
      })
    } catch {
      return res.status(502).json({
        error: 'upstream_unreachable',
        message: 'Could not reach the January Developer API. Try again shortly.',
      })
    }

    // The mint response is the contract your app decodes; the request id is
    // what January support can trace. Log the outcome, never a token value.
    const requestId = upstream.headers.get('x-request-id')
    if (requestId) res.setHeader('X-Request-Id', requestId)
    console.log(`minted=${upstream.ok} status=${upstream.status} end_user=${endUserId}`)

    const body = await upstream.json().catch(() => ({
      error: 'upstream_error',
      message: 'The January Developer API returned an unreadable response.',
    }))
    const hint = SETUP_HINTS[upstream.status]
    if (hint) console.error(`January answered ${upstream.status}. ${hint}`)
    return res.status(upstream.status).json(hint ? { ...body, hint } : body)
  }
}

/**
 * Asks January whether an API key is good by reading the account's credit
 * balance — the one call that never costs a credit and never counts against
 * request limits. Tells a rejected key (401) from one issued for the other
 * API version (403) from January being unreachable, so callers can be exact.
 */
export async function checkApiKey({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  let response
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${CREDITS_PATH}`, {
      method: 'GET',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { authorization: `Bearer ${apiKey}` },
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'rejected' }
  if (response.status === 403) return { ok: false, reason: 'wrong_version' }
  return { ok: false, reason: 'unverified' }
}
