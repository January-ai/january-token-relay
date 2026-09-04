import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkApiKey, createRelayHandler } from '../lib/relay.js'
import { buildVerifier, SessionError } from '../lib/verify.js'

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

// ——— relay-token verification ———————————————————————————————————————————————

test('the right relay token and a named user pass', async () => {
  const verify = buildVerifier({ relayToken: 'beta-window' })
  assert.deepEqual(
    await verify({ authorization: 'Bearer beta-window', 'x-end-user-id': 'tester-1' }),
    { endUserId: 'tester-1' },
  )
})

test('a wrong relay token is refused', async () => {
  const verify = buildVerifier({ relayToken: 'beta-window' })
  await assert.rejects(
    verify({ authorization: 'Bearer wrong', 'x-end-user-id': 'tester-1' }),
    SessionError,
  )
})

test('a missing Authorization header is refused with instructions', async () => {
  const verify = buildVerifier({ relayToken: 'beta-window' })
  await assert.rejects(verify({ 'x-end-user-id': 'tester-1' }), /Authorization: Bearer/)
})

test('a missing x-end-user-id header is refused with instructions', async () => {
  const verify = buildVerifier({ relayToken: 'beta-window' })
  await assert.rejects(verify({ authorization: 'Bearer beta-window' }), /x-end-user-id/)
})

test('user ids are trimmed, so padding cannot create a second identity upstream', async () => {
  const verify = buildVerifier({ relayToken: 's' })
  assert.deepEqual(await verify({ authorization: 'Bearer s', 'x-end-user-id': '  u1  ' }), {
    endUserId: 'u1',
  })
})

test('without a relay token the verifier is open: no Authorization needed, a user still is', async () => {
  const verify = buildVerifier({})
  assert.equal(verify.relayTokenRequired, false)
  assert.deepEqual(await verify({ 'x-end-user-id': 'tester-1' }), { endUserId: 'tester-1' })
  assert.deepEqual(
    await verify({ authorization: 'Bearer anything', 'x-end-user-id': 'tester-1' }),
    {
      endUserId: 'tester-1',
    },
  )
  await assert.rejects(verify({}), /x-end-user-id/)
})

test('with a relay token the verifier says so, for the usage answer', () => {
  assert.equal(buildVerifier({ relayToken: 'beta-window' }).relayTokenRequired, true)
})

// ——— the relay handler ——————————————————————————————————————————————————————

test('a verified caller mints for exactly the named user and relays the 201 verbatim', async () => {
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
  assert.equal(JSON.parse(capture.init.body).end_user_id, 'user-1')
})

test('with TOKEN_SCOPES unset every scope is requested, because January requires the field', async () => {
  const capture = {}
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED, capture),
  })
  await handler({ method: 'POST', headers: {} }, fakeRes())

  assert.deepEqual(JSON.parse(capture.init.body).scopes, [
    'foods:read',
    'food_analysis:write',
    'food_logs:read',
    'food_logs:write',
    'glucose:read',
    'restaurants:read',
  ])
})

test('TOKEN_SCOPES and TOKEN_TTL_SECONDS become relay policy on the mint body', async () => {
  const capture = {}
  const handler = createRelayHandler({
    env: {
      JANUARY_API_KEY: 'sk-x',
      TOKEN_SCOPES: 'foods:read, glucose:read,',
      TOKEN_TTL_SECONDS: '900',
    },
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

test('a failed check is the relay’s own 401 and January is never called', async () => {
  let called = false
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => {
      throw new SessionError('no match')
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

test('January’s refusals pass through — status, code and message — with a hint on the setup errors', async () => {
  const refusal = {
    message: 'Client tokens are not enabled for this account yet.',
    code: 'forbidden',
  }
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(403, refusal),
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'forbidden')
  assert.equal(res.body.message, refusal.message)
  assert.match(res.body.hint, /Client tokens/)
  assert.match(res.body.hint, /dashboard\.january\.ai/)
})

test('a 401 from the mint means January rejected the relay’s own API key, and the hint says so', async () => {
  const refusal = { code: 'unauthorized', message: 'Invalid or unauthorized token' }
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(401, refusal),
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'unauthorized')
  assert.match(res.body.hint, /JANUARY_API_KEY/)
  assert.match(res.body.hint, /dashboard\.january\.ai/)
})

test('other January answers, like a 429, stay exactly as January sent them', async () => {
  const limit = { code: 'rate_limited', message: 'Minting is capped.' }
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(429, limit),
  })
  const res = fakeRes()
  await handler({ method: 'POST', headers: {} }, res)

  assert.equal(res.statusCode, 429)
  assert.deepEqual(res.body, limit)
})

// ——— checking the API key with January (free: reading the balance costs nothing) ———

function creditsRespondsWith(status, capture = {}) {
  return async (url, init) => {
    capture.url = url
    capture.init = init
    return { ok: status < 400, status }
  }
}

test('checkApiKey reads the credit balance with the key, the one call that is always free', async () => {
  const capture = {}
  const result = await checkApiKey({ apiKey: 'sk-x', fetchImpl: creditsRespondsWith(200, capture) })
  assert.deepEqual(result, { ok: true })
  assert.equal(capture.url, 'https://partners.january.ai/v1.2/credits')
  assert.equal(capture.init.method, 'GET')
  assert.equal(capture.init.headers.authorization, 'Bearer sk-x')
})

test('checkApiKey honours JANUARY_BASE_URL', async () => {
  const capture = {}
  await checkApiKey({
    apiKey: 'sk-x',
    baseUrl: 'http://127.0.0.1:9/',
    fetchImpl: creditsRespondsWith(200, capture),
  })
  assert.equal(capture.url, 'http://127.0.0.1:9/v1.2/credits')
})

test('checkApiKey tells a rejected key from a wrong-version key from an unreachable January', async () => {
  assert.deepEqual(await checkApiKey({ apiKey: 'sk-x', fetchImpl: creditsRespondsWith(401) }), {
    ok: false,
    reason: 'rejected',
  })
  assert.deepEqual(await checkApiKey({ apiKey: 'sk-x', fetchImpl: creditsRespondsWith(403) }), {
    ok: false,
    reason: 'wrong_version',
  })
  assert.deepEqual(await checkApiKey({ apiKey: 'sk-x', fetchImpl: creditsRespondsWith(503) }), {
    ok: false,
    reason: 'unverified',
  })
  assert.deepEqual(
    await checkApiKey({
      apiKey: 'sk-x',
      fetchImpl: async () => {
        throw new Error('network down')
      },
    }),
    { ok: false, reason: 'unreachable' },
  )
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

test('GET answers with usage and never touches the upstream — a browser visit cannot mint', async () => {
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: async () => {
      throw new Error('GET must never call January')
    },
  })
  const res = fakeRes()
  await handler({ method: 'GET', headers: {} }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'ok')
  assert.equal(res.body.relay_token_required, true)
  assert.match(res.body.usage, /Authorization: Bearer/)
  assert.match(res.body.usage, /x-end-user-id/)
})

test('GET tells an open relay’s callers they need only the user header', async () => {
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: buildVerifier({}),
    fetchImpl: januaryRespondsWith(201, MINTED),
  })
  const res = fakeRes()
  await handler({ method: 'GET', headers: {} }, res)

  assert.equal(res.body.relay_token_required, false)
  assert.doesNotMatch(res.body.usage, /Authorization/)
  assert.match(res.body.usage, /x-end-user-id/)
})

test('non-POST methods are refused; OPTIONS preflight succeeds for an allowed origin', async () => {
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x', ALLOWED_ORIGINS: 'https://app.test' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED),
  })

  const put = fakeRes()
  await handler({ method: 'PUT', headers: {} }, put)
  assert.equal(put.statusCode, 405)

  const preflight = fakeRes()
  await handler({ method: 'OPTIONS', headers: { origin: 'https://app.test' } }, preflight)
  assert.equal(preflight.statusCode, 204)
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'https://app.test')

  const stranger = fakeRes()
  await handler({ method: 'OPTIONS', headers: { origin: 'https://evil.test' } }, stranger)
  assert.equal(stranger.headers['Access-Control-Allow-Origin'], undefined)
})

test('a missing API key is a clear misconfiguration answer — on GET too, so the health check cannot lie', async () => {
  const handler = createRelayHandler({
    env: {},
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED),
  })

  for (const method of ['POST', 'GET']) {
    const res = fakeRes()
    await handler({ method, headers: {} }, res)
    assert.equal(res.statusCode, 500, `${method} should surface the misconfiguration`)
    assert.equal(res.body.error, 'relay_misconfigured')
  }
})
