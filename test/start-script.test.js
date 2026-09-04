import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Drives ./start.sh the way a developer does: a fresh clone in a temp folder,
 * the key pasted on stdin, and the relay expected to come up. Every case runs
 * on a scratch copy, so the real .env is never touched.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEY = `sk-${'a'.repeat(43)}`

function freshClone() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-start-'))
  for (const entry of [
    'start.sh',
    'server.js',
    'index.html',
    '.env.example',
    'package.json',
    'api',
    'lib',
  ]) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  }
  return dir
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** A stand-in January: the balance read answers 401 for keys containing REJECT, 200 otherwise. */
function stubJanuary() {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      const rejected = (req.headers.authorization ?? '').includes('REJECT')
      const status = req.url === '/v1.2/credits' ? (rejected ? 401 : 200) : 404
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          status === 200 ? { plan: 'stub' } : { code: 'unauthorized', message: 'nope' },
        ),
      )
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    )
  })
}

const REJECTED_KEY = `sk-REJECT${'x'.repeat(37)}`

/** Runs the script; resolves when the relay banner appears or the script exits. */
async function runScript(dir, { stdin = '', env = {} } = {}) {
  const port = await freePort()
  const january = await stubJanuary()
  return new Promise((resolve) => {
    const child = spawn('bash', ['start.sh'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PORT: String(port),
        JANUARY_BASE_URL: january.url,
        ...env,
      },
    })
    let out = ''
    let err = ''
    const finish = (code) => {
      child.kill()
      january.close()
      resolve({ code, out, err, all: out + err })
    }
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('Press Ctrl+C')) finish(null)
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('exit', (code) => finish(code))
    child.stdin.end(stdin)
  })
}

function envLine(dir, name) {
  const match = readFileSync(join(dir, '.env'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))
  return match ? match[1] : undefined
}

test('start.sh: a fresh clone — the pasted key lands in .env, no relay token is needed, and the relay starts', async () => {
  const dir = freshClone()
  try {
    const run = await runScript(dir, { stdin: `${KEY}\n` })

    assert.equal(run.code, null, `the relay should have started; output was:\n${run.all}`)
    assert.equal(envLine(dir, 'JANUARY_API_KEY'), KEY)
    assert.equal(
      envLine(dir, 'RELAY_TOKEN'),
      '',
      'no relay token on a laptop: nothing else can reach it',
    )
    assert.match(
      readFileSync(join(dir, '.env'), 'utf8'),
      /# PORT=8787/,
      'the other settings survive',
    )
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600, '.env is private to the user')
    assert.match(run.out, /Endpoint +http:\/\/localhost:\d+\/api\/january\/client-token/)
    assert.match(run.out, /x-end-user-id/)
    assert.doesNotMatch(
      run.out,
      /Authorization/,
      'no bearer header to explain when no token is set',
    )
    assert.match(run.out, /curl -X POST http:\/\/localhost:\d+\/api\/january\/client-token/)
    assert.match(run.out, /accepted by January/, 'the key was checked with January before use')
    for (const sdk of ['iOS', 'Android', 'React Native', 'Web']) {
      assert.ok(run.out.includes(sdk), `the banner points to the ${sdk} guide`)
    }
    assert.match(run.out, /docs\.january\.ai\/ios-sdk\/getting-started\/authentication/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: something that is not an sk- key is refused and asked for again', async () => {
  const dir = freshClone()
  try {
    const run = await runScript(dir, { stdin: `not-a-key\n${KEY}\n` })

    assert.equal(run.code, null, run.all)
    assert.match(run.all, /sk-/)
    assert.equal(envLine(dir, 'JANUARY_API_KEY'), KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: a key pasted twice is refused with a message that says so', async () => {
  const dir = freshClone()
  try {
    const run = await runScript(dir, { stdin: `${KEY}${KEY}\n${KEY}\n` })

    assert.equal(run.code, null, run.all)
    assert.match(run.err, /twice/)
    assert.equal(envLine(dir, 'JANUARY_API_KEY'), KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: a key January rejects is refused and asked for again, before anything is saved', async () => {
  const dir = freshClone()
  try {
    const run = await runScript(dir, { stdin: `${REJECTED_KEY}\n${KEY}\n` })

    assert.equal(run.code, null, run.all)
    assert.match(run.err, /January rejected/)
    assert.equal(envLine(dir, 'JANUARY_API_KEY'), KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: a saved key that January now rejects is not reused — a new one is asked for', async () => {
  const dir = freshClone()
  try {
    writeFileSync(join(dir, '.env'), `JANUARY_API_KEY=${REJECTED_KEY}\n`)
    const run = await runScript(dir, { stdin: `${KEY}\n` })

    assert.equal(run.code, null, run.all)
    assert.match(run.err, /January rejected/)
    assert.equal(envLine(dir, 'JANUARY_API_KEY'), KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: with a complete .env nothing is asked, the saved values are kept, and a saved token is not enforced on a laptop', async () => {
  const dir = freshClone()
  try {
    const saved = `JANUARY_API_KEY=${KEY}\nRELAY_TOKEN=already-chosen-token-value-1234567890\nPORT=1\n`
    writeFileSync(join(dir, '.env'), saved)
    const run = await runScript(dir, { stdin: '' })

    assert.equal(run.code, null, run.all)
    assert.equal(envLine(dir, 'JANUARY_API_KEY'), KEY)
    assert.equal(envLine(dir, 'RELAY_TOKEN'), 'already-chosen-token-value-1234567890')
    assert.doesNotMatch(
      run.out,
      /Authorization/,
      'on loopback a token left in .env is not checked or mentioned',
    )
    assert.match(run.out, /No relay token is needed here/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: without a terminal and without a key it stops with instructions instead of hanging', async () => {
  const dir = freshClone()
  try {
    const run = await runScript(dir, { stdin: '' })

    assert.equal(run.code, 1)
    assert.match(run.err, /JANUARY_API_KEY/)
    assert.match(run.err, /\.env/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: JANUARY_API_KEY in the environment skips the question', async () => {
  const dir = freshClone()
  try {
    const run = await runScript(dir, { stdin: '', env: { JANUARY_API_KEY: KEY } })

    assert.equal(run.code, null, run.all)
    assert.equal(envLine(dir, 'JANUARY_API_KEY'), KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: opened to the Wi-Fi, a relay token is generated because other devices can reach it', async () => {
  const dir = freshClone()
  try {
    // A bad PORT stops server.js right after setup, so nothing binds to the network here.
    const run = await runScript(dir, { stdin: `${KEY}\n`, env: { HOST: '0.0.0.0', PORT: 'none' } })

    assert.equal(run.code, 1)
    const relayToken = envLine(dir, 'RELAY_TOKEN')
    assert.ok(relayToken.length >= 32, 'a long random relay token is generated')
    assert.ok(run.out.includes(relayToken), 'the relay token is shown, so it can go into the app')
    assert.match(run.err, /PORT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start.sh: an old Node.js is refused with a pointer to nodejs.org', async () => {
  const dir = freshClone()
  try {
    const shims = join(dir, 'shims')
    mkdirSync(shims)
    writeFileSync(join(shims, 'node'), '#!/bin/sh\necho v18.19.0\n')
    chmodSync(join(shims, 'node'), 0o755)
    const run = await runScript(dir, {
      stdin: `${KEY}\n`,
      env: { PATH: `${shims}:${process.env.PATH}` },
    })

    assert.equal(run.code, 1)
    assert.match(run.err, /20\.12/)
    assert.match(run.err, /nodejs\.org/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
