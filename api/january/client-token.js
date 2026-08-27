import { createRelayHandler } from '../../lib/relay.js'
import { resolveConfig } from '../../lib/providers.js'
import { buildVerifier } from '../../lib/verify.js'

// Resolved once per cold start: a misconfigured deployment fails loudly on its
// first request with a message naming the missing variable.
let handler
function ensureHandler() {
  if (!handler) {
    const config = resolveConfig(process.env)
    handler = createRelayHandler({ env: process.env, verify: buildVerifier(config) })
  }
  return handler
}

export default async function clientToken(req, res) {
  try {
    return await ensureHandler()(req, res)
  } catch (error) {
    // RelayConfigError and anything unexpected: say something actionable
    // without leaking internals, and log the rest for the function logs.
    console.error('relay error:', error?.message)
    return res.status(500).json({
      error: 'relay_misconfigured',
      message: error?.name === 'RelayConfigError' ? error.message : 'Unexpected relay error; check the function logs.',
    })
  }
}
