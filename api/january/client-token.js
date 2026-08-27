import { createRelayHandler } from '../../lib/relay.js'
import { buildVerifier } from '../../lib/verify.js'

// Wired once per cold start; a missing variable fails loudly on the first
// request with a message naming exactly what to set.
let handler
function ensureHandler() {
  if (!handler) {
    const relayToken = process.env.RELAY_TOKEN?.trim()
    if (!relayToken) {
      throw new Error('RELAY_TOKEN is not set in the deployment environment.')
    }
    handler = createRelayHandler({ env: process.env, verify: buildVerifier({ relayToken }) })
  }
  return handler
}

export default async function clientToken(req, res) {
  try {
    return await ensureHandler()(req, res)
  } catch (error) {
    console.error('relay error:', error?.message)
    return res
      .status(500)
      .json({ error: 'relay_misconfigured', message: error?.message ?? 'Unexpected relay error.' })
  }
}
