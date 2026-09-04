import { createServer } from 'node:http'

export const ENDPOINT_PATH = '/api/january/client-token'
/** Where each SDK documents its token provider — the code that calls this relay. */
export const SDK_GUIDES = [
  ['iOS', 'https://docs.january.ai/ios-sdk/getting-started/authentication'],
  ['Android', 'https://docs.january.ai/android-sdk/getting-started/authentication'],
  ['React Native', 'https://docs.january.ai/react-native-sdk/getting-started/authentication'],
  ['Web', 'https://docs.january.ai/web-sdk/getting-started/authentication'],
]
const DEFAULT_PORT = 8787
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const EVERY_INTERFACE = new Set(['0.0.0.0', '::'])

/** True for hosts only this machine can reach. */
export function isLoopback(host) {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * The variables the local server cannot start without: the API key always,
 * and a relay token as soon as other devices can reach the relay (any host
 * but loopback), because the token is what keeps the relay yours alone.
 */
export function missingRequiredEnv({ env, host }) {
  const required = isLoopback(host) ? ['JANUARY_API_KEY'] : ['JANUARY_API_KEY', 'RELAY_TOKEN']
  return required.filter((name) => !env[name]?.trim())
}

/** PORT as a number — 8787 when unset — refusing anything that is not a real port. */
export function readPort(raw) {
  const value = raw?.trim()
  if (!value) return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, not "${raw}".`)
  }
  return port
}

/**
 * The URLs the relay answers on, for the startup banner: localhost (what the
 * simulator uses); plus every LAN address when bound to all interfaces, which
 * is what a physical phone on the same Wi-Fi needs; or exactly the one address
 * it was told to bind.
 */
export function baseUrls({ host, port, interfaces }) {
  if (LOOPBACK_HOSTS.has(host)) return [`http://localhost:${port}`]
  if (!EVERY_INTERFACE.has(host)) return [`http://${host}:${port}`]
  const lan = Object.values(interfaces)
    .flat()
    .filter((iface) => iface.family === 'IPv4' && !iface.internal)
    .map((iface) => `http://${iface.address}:${port}`)
  return [`http://localhost:${port}`, ...lan]
}

/** Minimal stand-in for the helpers Vercel adds to Node's response object. */
function vercelify(res) {
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (body) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
    return res
  }
  return res
}

/**
 * Serves the relay the way Vercel does, on plain node:http: the status page at
 * the root, the function at its path with the same res.status().json()
 * helpers, and nothing else. This is what `npm start` runs, and what the e2e
 * tests drive over a real socket.
 */
export function createLocalServer({ handler, indexHtml }) {
  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(indexHtml)
      return
    }
    if (pathname !== ENDPOINT_PATH) {
      vercelify(res)
        .status(404)
        .json({ error: 'not_found', message: `The relay endpoint is ${ENDPOINT_PATH}.` })
      return
    }
    try {
      await handler(req, vercelify(res))
    } catch (error) {
      console.error('relay error:', error?.message)
      if (res.headersSent) res.end()
      else
        res
          .status(500)
          .json({ error: 'relay_error', message: 'Unexpected relay error; see the terminal.' })
    }
  })
}
