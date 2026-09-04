import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  baseUrls,
  createLocalServer,
  ENDPOINT_PATH,
  isLoopback,
  missingRequiredEnv,
  readPort,
  SDK_GUIDES,
} from './lib/local-server.js'
import { checkApiKey, createRelayHandler } from './lib/relay.js'
import { buildVerifier } from './lib/verify.js'

/**
 * Runs the relay on your own machine: the same handler Vercel deploys, served
 * by node:http. ./start.sh sets up .env and runs this; `npm start` runs it
 * from an existing .env.
 */
const rootDir = new URL('./', import.meta.url)

// Variables already set in the shell win over the file, as with `node --env-file`.
const envFile = fileURLToPath(new URL('.env', rootDir))
if (existsSync(envFile)) process.loadEnvFile(envFile)

// Loopback only, unless told otherwise: HOST=0.0.0.0 opens the relay to your
// Wi-Fi for a physical phone — and then a relay token is required. On loopback
// nothing else can reach the relay, so no token is checked, whatever .env says.
const host = process.env.HOST?.trim() || '127.0.0.1'
const relayToken = isLoopback(host) ? undefined : process.env.RELAY_TOKEN?.trim()

const missing = missingRequiredEnv({ env: process.env, host })
if (missing.includes('JANUARY_API_KEY')) {
  console.error('JANUARY_API_KEY is not set.')
  console.error(
    'Run ./start.sh to be walked through it, or copy .env.example to .env and paste your sk-… key from https://dashboard.january.ai.',
  )
  process.exit(1)
}
if (missing.includes('RELAY_TOKEN')) {
  console.error(`RELAY_TOKEN is not set, and with HOST=${host} other devices can reach the relay.`)
  console.error(
    'Run ./start.sh to have one generated, or set any long random secret as RELAY_TOKEN in .env.',
  )
  process.exit(1)
}

let port
try {
  port = readPort(process.env.PORT)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

// Prove the key with January before anyone points an app here. Reading the
// balance is free; a rejected key stops the relay with the fix spelled out.
const apiKey = process.env.JANUARY_API_KEY.trim()
const maskedKey = `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`
const check = await checkApiKey({
  apiKey,
  baseUrl: process.env.JANUARY_BASE_URL?.trim() || undefined,
})
if (check.reason === 'rejected') {
  console.error(
    `January rejected the API key in .env (${maskedKey}). It may have been rotated or deleted.`,
  )
  console.error(
    'Create a new key at https://dashboard.january.ai → API keys, then run ./start.sh again and paste it.',
  )
  process.exit(1)
}
if (check.reason === 'wrong_version') {
  console.error(
    `The API key in .env (${maskedKey}) is for the other API version; this relay needs a v1.2 key.`,
  )
  console.error(
    'Create one at https://dashboard.january.ai → API keys, then run ./start.sh again and paste it.',
  )
  process.exit(1)
}
const keyStatus = check.ok
  ? `${maskedKey}  accepted by January`
  : `${maskedKey}  not checked — January could not be reached just now`

const server = createLocalServer({
  handler: createRelayHandler({ env: process.env, verify: buildVerifier({ relayToken }) }),
  indexHtml: readFileSync(new URL('index.html', rootDir), 'utf8'),
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use. Stop the other process, or run PORT=<another port> npm start.`,
    )
  } else {
    console.error(error.message)
  }
  process.exit(1)
})

// OSC 8 hyperlinks: terminals that support them (iTerm2, VS Code, Windows
// Terminal, …) make these clickable; the others show the plain URL.
const ESC = String.fromCharCode(27)
const link = (url) =>
  process.stdout.isTTY ? `${ESC}]8;;${url}${ESC}\\${url}${ESC}]8;;${ESC}\\` : url

server.listen(port, host, () => {
  const [local, ...lan] = baseUrls({ host, port, interfaces: networkInterfaces() })
  const endpoint = `${local}${ENDPOINT_PATH}`
  const banner = [
    'January Token Relay is running on this machine (development only).',
    '',
    `  API key       ${keyStatus}`,
    `  Status page   ${link(local)}`,
    `  Endpoint      ${link(endpoint)}`,
    ...lan.map(
      (url) => `  On your Wi-Fi ${link(`${url}${ENDPOINT_PATH}`)}   (for a physical phone)`,
    ),
    '',
    'Your app’s token provider makes this request and returns the JSON as-is:',
    '',
    `  POST ${endpoint}`,
    ...(relayToken ? ['  Authorization: Bearer <RELAY_TOKEN>      the value in .env'] : []),
    '  x-end-user-id: <your id for the signed-in user>',
    '',
    relayToken
      ? 'The relay token keeps this relay yours alone. It lives in .env as RELAY_TOKEN.'
      : 'No relay token is needed here: nothing outside this machine can reach the relay.',
    '',
    `Try it:  curl -X POST ${endpoint}${relayToken ? " -H 'Authorization: Bearer <RELAY_TOKEN>'" : ''} -H 'x-end-user-id: demo-user-1'`,
    '',
    'Writing the provider, per SDK:',
    ...SDK_GUIDES.map(([name, url]) => `  ${name.padEnd(13)} ${link(url)}`),
    '',
    'Press Ctrl+C to stop.',
  ]
  console.log(banner.join('\n'))
})
