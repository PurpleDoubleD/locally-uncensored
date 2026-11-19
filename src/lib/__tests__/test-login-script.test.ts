/**
 * TEST-LOGIN (3.1.3): scripts/testbau/test-login.sh fetches the test
 * account's one-time token from the Supabase admin API and pipes it into the
 * test build. Run against a stand-in admin API on this machine and a stand-in
 * program: the program gets the token on its standard input, the service key
 * goes only in the request headers, and neither the token, the link nor the
 * key shows up in what the script prints or on any command line.
 *
 * Run: npx vitest run src/lib/__tests__/test-login-script.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const SCRIPT = join(root, 'scripts/testbau/test-login.sh')
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829'
const LINK = 'https://example.supabase.co/auth/v1/verify?token=SECRET-LINK-PART&type=magiclink'
const KEY = 'service-role-key-for-the-self-test'

let server: Server | null = null
afterEach(() => { server?.close(); server = null })

function adminApi(seen: { headers?: Record<string, unknown>; body?: string }, answer: unknown) {
  return new Promise<number>((resolve) => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        seen.headers = req.headers
        seen.body = body
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(answer))
      })
    }).listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
  })
}

function standInApp(dir: string) {
  const prog = join(dir, 'app')
  // Writes what it got: its arguments and its standard input.
  writeFileSync(prog, `#!/bin/sh\necho "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n`)
  chmodSync(prog, 0o755)
  return prog
}

function runScript(prog: string, port: number) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn('bash', [SCRIPT, prog], {
      env: { ...process.env, LU_TEST_LOGIN_EMAIL: 'test@example.com', LU_SUPABASE_URL: `http://127.0.0.1:${port}`, LU_TEST_LOGIN_KEY_FD3: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    ;(child.stdio[3] as NodeJS.WritableStream).end(KEY + '\n')
    let out = ''
    child.stdout!.on('data', (c) => { out += c })
    child.stderr!.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

async function waitFor(path: string) {
  for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 200))
}

describe('scripts/testbau/test-login.sh', () => {
  it('pipes the token into the app and prints none of it', async () => {
    const seen: { headers?: Record<string, unknown>; body?: string } = {}
    const port = await adminApi(seen, { action_link: LINK, properties: { hashed_token: TOKEN, action_link: LINK } })
    const dir = mkdtempSync(join(tmpdir(), 'lu-tls-'))
    const { code, out } = await runScript(standInApp(dir), port)
    expect(code).toBe(0)
    await waitFor(join(dir, 'stdin'))
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe(TOKEN + '\n')
    expect(readFileSync(join(dir, 'argv'), 'utf8').trim()).toBe('--test-login-stdin')
    // The admin API got the key in its headers and a magic link request.
    expect(seen.headers?.apikey).toBe(KEY)
    expect(seen.headers?.authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(seen.body ?? '{}')).toEqual({ type: 'magiclink', email: 'test@example.com' })
    // Nothing secret on the screen.
    for (const secret of [TOKEN, 'SECRET-LINK-PART', KEY]) expect(out).not.toContain(secret)
  })

  it('an answer without a token says why and hands the app nothing', async () => {
    const port = await adminApi({}, { msg: 'User not found' })
    const dir = mkdtempSync(join(tmpdir(), 'lu-tls-'))
    const { out } = await runScript(standInApp(dir), port)
    await waitFor(join(dir, 'stdin'))
    expect(out).toContain('User not found')
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('')
  })

  it('refuses any address that is not a Supabase project or this machine', async () => {
    const child = spawn('bash', [SCRIPT, '/bin/echo'], {
      env: { ...process.env, LU_TEST_LOGIN_EMAIL: 'test@example.com', LU_SUPABASE_URL: 'https://evil.example.com', LU_TEST_LOGIN_KEY_FD3: '1' },
    })
    let err = ''
    child.stderr.on('data', (c) => { err += c })
    const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? -1)))
    expect(code).toBe(2)
    expect(err).toContain('must be https://<ref>.supabase.co')
  })
})
