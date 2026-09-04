import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createLocalServer } from '../lib/local-server.js'
import { createRelayHandler } from '../lib/relay.js'
import { buildVerifier } from '../lib/verify.js'

/**
 * End-to-end over real HTTP: a fake January upstream and the relay both listen
 * on local ports, and the client is plain fetch. What the unit tests prove
 * about the handler, this proves about the deployed shape — headers cross a
 * real wire, and the relay is served exactly as `npm start` serves it, so the
 * local server's Vercel-style res helpers are exercised on a live socket.
 */

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
}

const MINTED = {
  token: 'ct-0123456789abcdefghijABCDEFGHIJklmnopqrstuvw',
  expires_in: 1800,
  expires_at: '2026-08-27T18:00:00.000Z',
  end_user_id: 'e2e-user-1',
  scopes: ['foods:read'],
}

async function startStack() {
  const upstreamRequests = []
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      upstreamRequests.push({ url: req.url, authorization: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-request-id', 'req-e2e-1')
      res.writeHead(201)
      res.end(JSON.stringify(MINTED))
    })
  })
  const upstreamPort = await listen(upstream)

  const handler = createRelayHandler({
    env: {
      JANUARY_API_KEY: `sk-${'x'.repeat(43)}`,
      JANUARY_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      ALLOWED_ORIGINS: 'https://app.test',
    },
    verify: buildVerifier({ relayToken: 'e2e-relay-token' }),
  })
  const relay = createLocalServer({ handler, indexHtml: '<h1>January Token Relay</h1>' })
  const relayPort = await listen(relay)

  return {
    url: `http://127.0.0.1:${relayPort}/api/january/client-token`,
    upstreamRequests,
    close: () => {
      upstream.close()
      relay.close()
    },
  }
}

test('e2e: a real HTTP round trip mints and relays verbatim, with the request id', async () => {
  const stack = await startStack()
  try {
    const res = await fetch(stack.url, {
      method: 'POST',
      headers: { authorization: 'Bearer e2e-relay-token', 'x-end-user-id': 'e2e-user-1' },
    })

    assert.equal(res.status, 201)
    assert.equal(res.headers.get('x-request-id'), 'req-e2e-1')
    assert.deepEqual(await res.json(), MINTED)

    assert.equal(stack.upstreamRequests.length, 1)
    const [mint] = stack.upstreamRequests
    assert.equal(mint.url, '/v1.2/auth/client-tokens')
    assert.match(mint.authorization, /^Bearer sk-/)
    const body = JSON.parse(mint.body)
    assert.equal(body.end_user_id, 'e2e-user-1')
    assert.ok(body.scopes.length > 0, 'January requires scopes on every mint')
  } finally {
    stack.close()
  }
})

test('e2e: a wrong relay token is refused over the wire and the upstream never hears about it', async () => {
  const stack = await startStack()
  try {
    const res = await fetch(stack.url, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'x-end-user-id': 'e2e-user-1' },
    })

    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'invalid_session')
    assert.equal(stack.upstreamRequests.length, 0)
  } finally {
    stack.close()
  }
})

test('e2e: CORS preflight answers 204 with the allowed origin echoed', async () => {
  const stack = await startStack()
  try {
    const res = await fetch(stack.url, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.test' },
    })

    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.test')
  } finally {
    stack.close()
  }
})

/**
 * Optional live check against a deployed relay. Runs only when both variables
 * are set (e.g. RELAY_E2E_URL=https://…vercel.app RELAY_E2E_TOKEN=…), so CI
 * and offline runs skip it. Mints a real token, so it counts toward the
 * account's mint limit.
 */
test('e2e (live): a deployed relay mints a real client token', {
  skip: !process.env.RELAY_E2E_URL || !process.env.RELAY_E2E_TOKEN,
}, async () => {
  const res = await fetch(`${process.env.RELAY_E2E_URL}/api/january/client-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RELAY_E2E_TOKEN}`,
      'x-end-user-id': 'relay-live-e2e',
    },
  })

  assert.equal(res.status, 201)
  const body = await res.json()
  assert.match(body.token, /^ct-[0-9A-Za-z]{43}$/)
  assert.equal(body.end_user_id, 'relay-live-e2e')
})
