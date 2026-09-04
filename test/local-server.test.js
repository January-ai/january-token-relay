import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baseUrls, createLocalServer, missingRequiredEnv, readPort } from '../lib/local-server.js'

// ——— startup checks —————————————————————————————————————————————————————————

test('on loopback only the API key is required, and a blank value counts as missing', () => {
  assert.deepEqual(missingRequiredEnv({ env: {}, host: '127.0.0.1' }), ['JANUARY_API_KEY'])
  assert.deepEqual(missingRequiredEnv({ env: { JANUARY_API_KEY: '  ' }, host: 'localhost' }), [
    'JANUARY_API_KEY',
  ])
  assert.deepEqual(missingRequiredEnv({ env: { JANUARY_API_KEY: 'sk-x' }, host: '127.0.0.1' }), [])
})

test('reachable by other devices, a relay token is required too', () => {
  assert.deepEqual(missingRequiredEnv({ env: { JANUARY_API_KEY: 'sk-x' }, host: '0.0.0.0' }), [
    'RELAY_TOKEN',
  ])
  assert.deepEqual(
    missingRequiredEnv({ env: { JANUARY_API_KEY: 'sk-x', RELAY_TOKEN: ' ' }, host: '10.0.0.5' }),
    ['RELAY_TOKEN'],
  )
  assert.deepEqual(
    missingRequiredEnv({
      env: { JANUARY_API_KEY: 'sk-x', RELAY_TOKEN: 's3cret' },
      host: '0.0.0.0',
    }),
    [],
  )
})

test('the port defaults to 8787 and must be a real port number', () => {
  assert.equal(readPort(undefined), 8787)
  assert.equal(readPort(''), 8787)
  assert.equal(readPort('3000'), 3000)
  for (const bad of ['abc', '0', '65536', '80.5']) {
    assert.throws(() => readPort(bad), /PORT/, `${bad} should be refused`)
  }
})

const INTERFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '192.168.1.23', family: 'IPv4', internal: false },
  ],
}

test('bound to loopback, the relay is reachable only as localhost', () => {
  assert.deepEqual(baseUrls({ host: '127.0.0.1', port: 8787, interfaces: INTERFACES }), [
    'http://localhost:8787',
  ])
})

test('bound to every interface, the LAN address is listed for physical devices', () => {
  assert.deepEqual(baseUrls({ host: '0.0.0.0', port: 8787, interfaces: INTERFACES }), [
    'http://localhost:8787',
    'http://192.168.1.23:8787',
  ])
})

test('bound to one specific address, that address is the URL', () => {
  assert.deepEqual(baseUrls({ host: '10.0.0.5', port: 9000, interfaces: INTERFACES }), [
    'http://10.0.0.5:9000',
  ])
})

// ——— routing ————————————————————————————————————————————————————————————————

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
  )
}

async function withServer(handler, run) {
  const server = createLocalServer({ handler, indexHtml: '<h1>January Token Relay</h1>' })
  const origin = await listen(server)
  try {
    await run(origin)
  } finally {
    server.close()
  }
}

test('the status page is served at the root, as Vercel serves index.html', async () => {
  await withServer(
    async () => {
      throw new Error('the page must not reach the handler')
    },
    async (origin) => {
      for (const path of ['/', '/index.html']) {
        const res = await fetch(`${origin}${path}`)
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /text\/html/)
        assert.match(await res.text(), /January Token Relay/)
      }
    },
  )
})

test('the endpoint path reaches the handler with Vercel’s res.status().json() helpers', async () => {
  const seen = {}
  await withServer(
    async (req, res) => {
      seen.method = req.method
      seen.userId = req.headers['x-end-user-id']
      return res.status(201).json({ token: 'ct-test' })
    },
    async (origin) => {
      const res = await fetch(`${origin}/api/january/client-token?ignored=1`, {
        method: 'POST',
        headers: { 'x-end-user-id': 'u1' },
      })
      assert.equal(res.status, 201)
      assert.match(res.headers.get('content-type'), /application\/json/)
      assert.deepEqual(await res.json(), { token: 'ct-test' })
      assert.deepEqual(seen, { method: 'POST', userId: 'u1' })
    },
  )
})

test('any other path is a JSON 404 that names the real endpoint', async () => {
  await withServer(
    async () => {
      throw new Error('a 404 must not reach the handler')
    },
    async (origin) => {
      const res = await fetch(`${origin}/api/january/token`, { method: 'POST' })
      assert.equal(res.status, 404)
      const body = await res.json()
      assert.equal(body.error, 'not_found')
      assert.match(body.message, /\/api\/january\/client-token/)
    },
  )
})

test('a handler that throws becomes a 500, not a hung connection', async () => {
  await withServer(
    async () => {
      throw new Error('boom')
    },
    async (origin) => {
      const res = await fetch(`${origin}/api/january/client-token`, { method: 'POST' })
      assert.equal(res.status, 500)
      assert.equal((await res.json()).error, 'relay_error')
    },
  )
})
