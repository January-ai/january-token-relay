import { timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/** The caller's session could not be verified. Always answered as the relay's own 401. */
export class SessionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionError'
  }
}

// Remote key sets are memoised per URL: jose caches the keys in memory and
// refetches only on an unknown key id, so a warm function verifies sessions
// with no network round-trip at all.
const remoteKeySets = new Map()
function keySetFor(url) {
  let keySet = remoteKeySets.get(url)
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(url))
    remoteKeySets.set(url, keySet)
  }
  return keySet
}

function bearerFrom(headers) {
  const value = headers['authorization'] ?? ''
  if (!value.startsWith('Bearer ')) {
    throw new SessionError('Send your login session token as "Authorization: Bearer <token>".')
  }
  return value.slice(7)
}

function equalConstantTime(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Builds the one function the relay needs: headers in, verified end user out.
 *
 * For JWT modes the user id comes from the *verified* claims — the request
 * body is never consulted, which is what makes a relay-minted token provably
 * belong to the user whose session it was. The shared-secret beta mode is the
 * documented exception: there is no session to derive from, so the app names
 * its user in the x-end-user-id header.
 */
export function buildVerifier(config) {
  if (config.type === 'shared-secret') {
    return async (headers) => {
      if (!equalConstantTime(bearerFrom(headers), config.secret)) {
        throw new SessionError('The shared secret does not match.')
      }
      const endUserId = (headers['x-end-user-id'] ?? '').trim()
      if (!endUserId) {
        throw new SessionError('Shared-secret mode requires an x-end-user-id header naming the user.')
      }
      return { endUserId }
    }
  }

  const key =
    config.type === 'secret' ? new TextEncoder().encode(config.secret) : keySetFor(config.jwksUrl)

  return async (headers) => {
    let payload
    try {
      ;({ payload } = await jwtVerify(bearerFrom(headers), key, {
        ...(config.issuer ? { issuer: config.issuer } : {}),
        ...(config.audience ? { audience: config.audience } : {}),
      }))
    } catch (error) {
      if (error instanceof SessionError) throw error
      // Expired, bad signature, wrong issuer/audience — all the same answer:
      // sign the user in again. Details go to the function log, not the caller.
      console.warn('session verification failed:', error?.code ?? error?.message)
      throw new SessionError('Your login session is invalid or expired. Sign in again.')
    }
    const endUserId = String(payload[config.userClaim] ?? '').trim()
    if (!endUserId) {
      // A verified session with no usable id is relay misconfiguration, not a
      // user problem — say so, naming the knob to turn.
      throw new SessionError(
        `The session verified but carries no "${config.userClaim}" claim. Check USER_CLAIM for your provider.`,
      )
    }
    return { endUserId }
  }
}
