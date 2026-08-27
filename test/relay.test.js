import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SignJWT } from 'jose'
import { resolveConfig, RelayConfigError } from '../lib/providers.js'
import { buildVerifier, SessionError } from '../lib/verify.js'
import { createRelayHandler } from '../lib/relay.js'

// ——— helpers ————————————————————————————————————————————————————————————————

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    ended: false,
    setHeader(name, value) {
      res.headers[name] = value
    },
    status(code) {
      res.statusCode = code
      return res
    },
    json(value) {
      res.body = value
      return res
    },
    end() {
      res.ended = true
      return res
    },
  }
  return res
}

const SECRET = 'test-secret-test-secret-test-secret!'

async function hs256Session(claims, { issuer = 'https://issuer.test/auth/v1', audience = 'authenticated' } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET))
}

function supabaseVerifier() {
  return buildVerifier(
    resolveConfig({
      AUTH_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://issuer.test',
      SUPABASE_JWT_SECRET: SECRET,
    }),
  )
}

const MINTED = {
  token: 'ct-0123456789abcdefghijABCDEFGHIJklmnopqrstuvw',
  expires_in: 1800,
  expires_at: '2026-08-27T18:00:00.000Z',
  end_user_id: 'user-1',
  scopes: ['foods:read'],
}

function januaryRespondsWith(status, body, capture = {}) {
  return async (url, init) => {
    capture.url = url
    capture.init = init
    return {
      ok: status < 400,
      status,
      headers: new Map([['x-request-id', 'req-123']]),
      json: async () => body,
    }
  }
}

// ——— provider presets ———————————————————————————————————————————————————————

test('firebase preset resolves Google keys, issuer and audience from the project id', () => {
  const config = resolveConfig({ AUTH_PROVIDER: 'firebase', FIREBASE_PROJECT_ID: 'acme-app' })
  assert.equal(config.issuer, 'https://securetoken.google.com/acme-app')
  assert.equal(config.audience, 'acme-app')
  assert.equal(config.userClaim, 'sub')
  assert.match(config.jwksUrl, /^https:\/\/www\.googleapis\.com\//)
})

test('a missing provider variable names itself in the error', () => {
  assert.throws(
    () => resolveConfig({ AUTH_PROVIDER: 'auth0', AUTH0_DOMAIN: 'acme.us.auth0.com' }),
    (error) => error instanceof RelayConfigError && /AUTH0_AUDIENCE/.test(error.message),
  )
})

test('an unknown provider lists the valid ones', () => {
  assert.throws(
    () => resolveConfig({ AUTH_PROVIDER: 'okta' }),
    (error) => error instanceof RelayConfigError && /firebase, clerk, auth0, supabase, jwt, shared-secret/.test(error.message),
  )
})

// ——— session verification (real crypto via the HS256 path) ——————————————————

test('a valid session yields the end user from the verified sub claim', async () => {
  const session = await hs256Session({ sub: 'supabase-user-9' })
  const { endUserId } = await supabaseVerifier()({ authorization: `Bearer ${session}` })
  assert.equal(endUserId, 'supabase-user-9')
})

test('a tampered session is refused as a SessionError', async () => {
  const session = await hs256Session({ sub: 'supabase-user-9' })
  await assert.rejects(
    supabaseVerifier()({ authorization: `Bearer ${session.slice(0, -2)}xx` }),
    SessionError,
  )
})

test('a session from the wrong issuer is refused', async () => {
  const session = await hs256Session({ sub: 'u' }, { issuer: 'https://elsewhere.test' })
  await assert.rejects(supabaseVerifier()({ authorization: `Bearer ${session}` }), SessionError)
})

test('shared-secret mode checks the secret and requires the user header', async () => {
  const verify = buildVerifier(
    resolveConfig({ AUTH_PROVIDER: 'shared-secret', RELAY_SHARED_SECRET: 'beta-window' }),
  )
  assert.deepEqual(
    await verify({ authorization: 'Bearer beta-window', 'x-end-user-id': 'tester-1' }),
    { endUserId: 'tester-1' },
  )
  await assert.rejects(verify({ authorization: 'Bearer wrong', 'x-end-user-id': 'tester-1' }), SessionError)
  await assert.rejects(verify({ authorization: 'Bearer beta-window' }), SessionError)
})

// ——— the relay handler ——————————————————————————————————————————————————————

test('a verified session mints for exactly that user and relays the 201 verbatim', async () => {
  const capture = {}
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED, capture),
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 201)
  assert.deepEqual(res.body, MINTED)
  assert.equal(res.headers['X-Request-Id'], 'req-123')
  assert.equal(capture.url, 'https://partners.january.ai/v1.2/auth/client-tokens')
  assert.equal(capture.init.headers.authorization, 'Bearer sk-x')
  // The verified identity is the whole body — nothing from the caller reaches it.
  assert.deepEqual(JSON.parse(capture.init.body), { end_user_id: 'user-1' })
})

test('TOKEN_SCOPES and TOKEN_TTL_SECONDS become relay policy on the mint body', async () => {
  const capture = {}
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x', TOKEN_SCOPES: 'foods:read, glucose:read', TOKEN_TTL_SECONDS: '900' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED, capture),
  })
  await handler({ method: 'POST', headers: {} }, fakeRes())

  assert.deepEqual(JSON.parse(capture.init.body), {
    end_user_id: 'user-1',
    scopes: ['foods:read', 'glucose:read'],
    ttl_seconds: 900,
  })
})

test('a failed session is the relay’s own 401 and January is never called', async () => {
  let called = false
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => {
      throw new SessionError('expired')
    },
    fetchImpl: async () => {
      called = true
    },
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(res.body.error, 'invalid_session')
  assert.equal(called, false)
})

test('January’s refusals pass through untouched — status, code and message', async () => {
  const refusal = { message: 'Client tokens are not enabled for this account yet.', code: 'forbidden' }
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(403, refusal),
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, refusal)
})

test('an unreachable upstream is a 502, not a hang or a crash', async () => {
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error, 'upstream_unreachable')
})

test('non-POST methods are refused; OPTIONS preflight succeeds for an allowed origin', async () => {
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x', ALLOWED_ORIGINS: 'https://app.test' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED),
  })

  const get = fakeRes()
  await handler({ method: 'GET', headers: {} }, get)
  assert.equal(get.statusCode, 405)

  const preflight = fakeRes()
  await handler({ method: 'OPTIONS', headers: { origin: 'https://app.test' } }, preflight)
  assert.equal(preflight.statusCode, 204)
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'https://app.test')

  const stranger = fakeRes()
  await handler({ method: 'OPTIONS', headers: { origin: 'https://evil.test' } }, stranger)
  assert.equal(stranger.headers['Access-Control-Allow-Origin'], undefined)
})

test('a missing API key is a clear misconfiguration answer', async () => {
  const handler = createRelayHandler({
    env: {},
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED),
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error, 'relay_misconfigured')
})
