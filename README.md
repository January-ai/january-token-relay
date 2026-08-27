# January Token Relay

The one backend endpoint a January mobile integration needs, ready to deploy in
about a minute. It exchanges your January API key for short-lived **client
tokens** — minted only for users **your own login system** has verified — so
your app talks to the January Developer API directly and your API key never
ships on a phone.

```
app ── login ─────────────► your auth (Firebase, Clerk, Auth0, Supabase, …)
app ── session token ─────► THIS RELAY ── sk-… + verified user id ──► January
app ◄───────────────────────  ct-… client token (expires ≤ 2 h)  ◄────┘
app ── every API call, Bearer ct-… ───────────────────────────────► January
```

The relay is one stateless function. It holds your `sk-` key in Vercel's
environment vault, checks the signature on the session token your login system
already gives your app, and mints a token for **exactly that user** — the user
id comes from the verified session, never from the request. It is called about
once per user per half hour (token refresh), so Vercel's free tier holds
indefinitely.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FJanuary-ai%2Fjanuary-token-relay&env=JANUARY_API_KEY,AUTH_PROVIDER&envDescription=Your%20January%20API%20key%20(sk-...)%20and%20your%20login%20provider%20(firebase%2C%20clerk%2C%20auth0%2C%20supabase%2C%20jwt)&project-name=january-token-relay&repository-name=january-token-relay)

1. Click the button. Vercel copies this repo into your account.
2. When prompted, paste your **`JANUARY_API_KEY`** (mint one in the
   [developer dashboard](https://dashboard.january.ai)) and set **`AUTH_PROVIDER`**
   to your login system: `firebase`, `clerk`, `auth0`, `supabase`, or `jwt`.
3. After the first deploy, add your provider's one or two variables
   (table below) under **Settings → Environment Variables**, then **Redeploy**.
4. Your endpoint is live at
   `https://<your-project>.vercel.app/api/january/client-token`.

| `AUTH_PROVIDER` | Add these variables | Where to find them |
|---|---|---|
| `firebase` | `FIREBASE_PROJECT_ID` | Firebase console → Project settings |
| `clerk` | `CLERK_ISSUER` | Clerk dashboard → API keys → Frontend API URL |
| `auth0` | `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` | Auth0 dashboard → Applications / APIs |
| `supabase` | `SUPABASE_URL` (+ `SUPABASE_JWT_SECRET` on classic projects) | Supabase → Project settings → API |
| `jwt` | `JWKS_URL` (+ optional `JWT_ISSUER`, `JWT_AUDIENCE`, `USER_CLAIM`) | your identity provider's docs |

Optional policy knobs: `TOKEN_SCOPES` (narrow what tokens may do),
`TOKEN_TTL_SECONDS` (300–7200, default 1800), `ALLOWED_ORIGINS` (web builds
only). See [.env.example](.env.example).

## Point the SDK at it

The app sends its **current login session token** — nothing else:

```swift
let january = try JanuaryClient(clientTokenProvider: {
    let session = try await Auth.auth().currentUser!.getIDToken()   // your auth SDK
    var request = URLRequest(url: URL(string: "https://<your-project>.vercel.app/api/january/client-token")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
    let (data, _) = try await URLSession.shared.data(for: request)
    return try JSONDecoder().decode(JanuaryClientToken.self, from: data)
})
```

The SDK handles caching, proactive refresh, and the retry-once-on-expiry
contract from there.

## Try it from a terminal

```bash
curl -X POST 'https://<your-project>.vercel.app/api/january/client-token' \
  -H 'Authorization: Bearer <a session token from your login system>'
```

A successful answer is January's mint response, relayed verbatim:

```json
{ "token": "ct-…", "expires_in": 1800, "expires_at": "…", "end_user_id": "…", "scopes": ["…"] }
```

## What the relay guarantees

- **Your API key never leaves the server.** It lives in Vercel's environment
  vault and appears only on the server-to-server call to January.
- **Tokens belong to proven users.** The end-user id is read from the
  cryptographically verified session — the request body is never consulted, so
  no caller can mint a token for someone else.
- **Errors are January's errors.** The relay adds exactly one error of its own
  (`401 invalid_session`: sign the user in again). Everything else — client
  tokens not enabled (403), mint rate limit (429) — passes through verbatim
  with January's `code`, so the SDK's refresh contract keeps working.

## Beta builds without login (`shared-secret`) — read this first

If you need TestFlight builds working **before** your login integration is
ready, `AUTH_PROVIDER=shared-secret` lets the app authenticate with one static
`RELAY_SHARED_SECRET` and name its user in an `x-end-user-id` header.

**This trades away the core guarantee**: anyone holding the secret can mint
tokens for any user id until you rotate it. Use it for a short beta window,
rotate the secret when the window closes, and never ship it in a production
release. If your app has real users, use your real login system.

## Local development

```bash
npm install
npm test          # unit tests, no network needed
vercel dev        # run the endpoint locally with your .env
```

## Moving off the relay later

Nothing to migrate: the relay speaks the same contract as a token endpoint
inside your own backend (verify session → mint → relay verbatim). When your
backend is ready, implement the same three steps there, point the SDK at the
new URL, and delete the Vercel project.
