import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRelayHandler } from '../lib/relay.js'
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
  assert.deepEqual(JSON.parse(capture.init.body), { end_user_id: 'user-1' })
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

test('January’s refusals pass through untouched — status, code and message', async () => {
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

test('GET answers with usage — a browser visit is a question, not a mistake', async () => {
  const handler = createRelayHandler({
    env: { JANUARY_API_KEY: 'sk-x' },
    verify: async () => ({ endUserId: 'user-1' }),
    fetchImpl: januaryRespondsWith(201, MINTED),
  })
  const res = fakeRes()
  await handler({ method: 'GET', headers: {} }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'ok')
  assert.match(res.body.usage, /Authorization: Bearer/)
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
