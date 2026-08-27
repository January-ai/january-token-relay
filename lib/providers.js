/**
 * Turns AUTH_PROVIDER plus a couple of provider-specific env vars into one
 * verification config. Every preset resolves to the same small shape, because
 * checking a session token is the same operation everywhere — only where the
 * keys live and what the user-id claim is called differ per provider.
 *
 *   { type: 'jwks',          jwksUrl, issuer?, audience?, userClaim }
 *   { type: 'secret',        secret,  issuer?, audience?, userClaim }   // HS256
 *   { type: 'shared-secret', secret }                                   // beta only
 */

export class RelayConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RelayConfigError'
  }
}

function required(env, name, provider) {
  const value = env[name]?.trim()
  if (!value) {
    throw new RelayConfigError(`AUTH_PROVIDER=${provider} requires the ${name} environment variable.`)
  }
  return value
}

/** Strips a trailing slash so issuer/URL joins below can't double it. */
const origin = (url) => url.replace(/\/+$/, '')

const PROVIDERS = {
  firebase(env) {
    const projectId = required(env, 'FIREBASE_PROJECT_ID', 'firebase')
    return {
      type: 'jwks',
      jwksUrl: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      userClaim: 'sub',
    }
  },

  clerk(env) {
    // The instance's issuer domain, e.g. https://your-app.clerk.accounts.dev
    // or your production Clerk domain.
    const issuer = origin(required(env, 'CLERK_ISSUER', 'clerk'))
    return {
      type: 'jwks',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      issuer,
      // Clerk session tokens carry `azp` rather than a stable audience;
      // set CLERK_AUDIENCE only if you mint JWT templates with one.
      audience: env.CLERK_AUDIENCE?.trim() || undefined,
      userClaim: 'sub',
    }
  },

  auth0(env) {
    const domain = origin(required(env, 'AUTH0_DOMAIN', 'auth0')).replace(/^https?:\/\//, '')
    return {
      type: 'jwks',
      jwksUrl: `https://${domain}/.well-known/jwks.json`,
      // Auth0 issuers carry a trailing slash on purpose.
      issuer: `https://${domain}/`,
      audience: required(env, 'AUTH0_AUDIENCE', 'auth0'),
      userClaim: 'sub',
    }
  },

  supabase(env) {
    const url = origin(required(env, 'SUPABASE_URL', 'supabase'))
    const secret = env.SUPABASE_JWT_SECRET?.trim()
    const shared = { issuer: `${url}/auth/v1`, audience: 'authenticated', userClaim: 'sub' }
    // Classic projects sign with a symmetric secret; newer ones publish JWKS.
    return secret
      ? { type: 'secret', secret, ...shared }
      : { type: 'jwks', jwksUrl: `${url}/auth/v1/.well-known/jwks.json`, ...shared }
  },

  /** Any other login system that issues signed JWTs and publishes its keys. */
  jwt(env) {
    return {
      type: 'jwks',
      jwksUrl: required(env, 'JWKS_URL', 'jwt'),
      issuer: env.JWT_ISSUER?.trim() || undefined,
      audience: env.JWT_AUDIENCE?.trim() || undefined,
      userClaim: env.USER_CLAIM?.trim() || 'sub',
    }
  },

  /**
   * Beta builds only (e.g. a TestFlight window before your backend exists).
   * The app authenticates with one static secret and NAMES its own user, so a
   * leaked secret can mint for arbitrary user ids until you rotate it. Never
   * ship this mode in a production release — see the README warning.
   */
  'shared-secret'(env) {
    return { type: 'shared-secret', secret: required(env, 'RELAY_SHARED_SECRET', 'shared-secret') }
  },
}

export function resolveConfig(env) {
  const provider = env.AUTH_PROVIDER?.trim().toLowerCase()
  if (!provider) {
    throw new RelayConfigError(
      `AUTH_PROVIDER is required. One of: ${Object.keys(PROVIDERS).join(', ')}.`,
    )
  }
  const preset = PROVIDERS[provider]
  if (!preset) {
    throw new RelayConfigError(
      `Unknown AUTH_PROVIDER "${provider}". One of: ${Object.keys(PROVIDERS).join(', ')}.`,
    )
  }
  return { provider, ...preset(env) }
}
