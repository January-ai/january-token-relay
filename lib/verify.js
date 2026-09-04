import { timingSafeEqual } from 'node:crypto'

/** The caller could not be authenticated. Always answered as the relay's own 401. */
export class SessionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionError'
  }
}

function bearerFrom(headers) {
  const value = headers.authorization ?? ''
  if (!value.startsWith('Bearer ')) {
    throw new SessionError('Send your relay token as "Authorization: Bearer <token>".')
  }
  return value.slice(7)
}

function equalConstantTime(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function endUserIdFrom(headers) {
  const endUserId = (headers['x-end-user-id'] ?? '').trim()
  if (!endUserId) {
    throw new SessionError('Send an x-end-user-id header naming the user this token is for.')
  }
  return endUserId
}

/**
 * The relay's authentication: one static relay token, chosen by you, checked
 * in constant time. The app presents it and names the user it is acting for
 * in the x-end-user-id header.
 *
 * Without a relay token the verifier is open — only the user header is
 * checked. That is right on your own machine, where nothing else can reach
 * the relay, and wrong anywhere else: the local server refuses to open the
 * relay to the network without a token, and the Vercel function insists on one.
 *
 * Deliberately simple — see "What this protects" in the README for the
 * tradeoff, and for the upgrade path (verifying your login system's sessions)
 * once your app has real users.
 */
export function buildVerifier({ relayToken } = {}) {
  const verify = relayToken
    ? async (headers) => {
        if (!equalConstantTime(bearerFrom(headers), relayToken)) {
          throw new SessionError('The relay token does not match.')
        }
        return { endUserId: endUserIdFrom(headers) }
      }
    : async (headers) => ({ endUserId: endUserIdFrom(headers) })
  verify.relayTokenRequired = Boolean(relayToken)
  return verify
}
