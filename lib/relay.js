import { SessionError } from './verify.js'

const DEFAULT_BASE_URL = 'https://partners.january.ai'
const MINT_PATH = '/v1.2/auth/client-tokens'
const UPSTREAM_TIMEOUT_MS = 10_000

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
  const scopes = env.TOKEN_SCOPES?.trim()
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
    const origin = req.headers['origin']
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-end-user-id')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed', message: 'POST to this endpoint.' })
    }
    if (!apiKey) {
      return res.status(500).json({
        error: 'relay_misconfigured',
        message: 'JANUARY_API_KEY is not set in the deployment environment.',
      })
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
          ...(scopes ? { scopes: scopes.split(',').map((scope) => scope.trim()) } : {}),
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
    return res.status(upstream.status).json(body)
  }
}
