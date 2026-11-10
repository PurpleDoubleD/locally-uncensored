/**
 * The list of secret paths (C59). The phone's tools run in Rust
 * (remote.rs) and use src-tauri/src/secret_paths.rs; the last test holds the
 * two lists against the Rust test's own sample paths.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dropSecretLines, secretAccessOf, secretNotice, secretPathReason } from '../secret-paths'

const SECRET = [
  '~/.huggingface/token', '~/.cache/huggingface/token', '/Users/x/.ssh/id_ed25519', '$HOME/.aws/credentials',
  '${HOME}/.aws/config', '~/.config/gcloud/application_default_credentials.json', '~/.netrc', '~/.git-credentials',
  '~/.docker/config.json', '~/Library/Keychains/login.keychain-db', 'certs/server.pem', 'deploy.key', 'id_rsa',
  '.env', 'app/.env.local', 'secrets.json', '/Volumes/MyCredentials/x.txt',
  '~/Library/Application Support/Google/Chrome/Default/Cookies', 'C:\\Users\\x\\.ssh\\config', '%USERPROFILE%\\.aws\\credentials',
  'file:///Users/x/.ssh/id_rsa', '~/.gnupg/private-keys-v1.d/x.key', '~/.config/gh/hosts.yml',
]
const ORDINARY = ['notes.txt', 'src/env.ts', '.env.example', 'docs/keys.md', 'README.md', 'config.json', 'src/secret-paths.ts', 'environment.md']

describe('secret paths', () => {
  it('every path on the list is refused', () => {
    for (const p of SECRET) expect(secretPathReason(p), p).toBeTruthy()
  })
  it('ordinary paths pass', () => {
    for (const p of ORDINARY) expect(secretPathReason(p), p).toBeNull()
  })
  it('a tool call is checked on its path arguments and command words, not on what it writes', () => {
    expect(secretAccessOf('file_read', { path: '~/.huggingface/token' })?.why).toMatch(/Hugging Face/)
    expect(secretAccessOf('shell_execute', { command: 'cat ~/.ssh/id_rsa | base64' })?.path).toBe('~/.ssh/id_rsa')
    expect(secretAccessOf('shell_execute', { command: 'export X=~/.aws/credentials' })).toBeTruthy()
    expect(secretAccessOf('shell_execute', { command: 'npm test' })).toBeNull()
    expect(secretAccessOf('file_write', { path: 'notes.md', content: 'cat ~/.ssh/id_rsa' })).toBeNull()
  })
  it('the user sees a notice that names the tool and the path', () => {
    expect(secretNotice('file_read', { path: '~/.netrc', why: 'stored passwords or tokens' })).toBe('🔒 Blocked: the model tried file_read on ~/.netrc (stored passwords or tokens). Nothing was read.')
  })
  it('a folder search loses the lines from secret files', () => {
    const out = dropSecretLines('src/a.ts:3: const t = 1\n.env:1: API_KEY=abc\napp/.env.local:2: X=y')
    expect(out).toContain('src/a.ts:3')
    expect(out).not.toContain('API_KEY')
    expect(out).toMatch(/2 line\(s\) from secret files left out/)
  })
  it('the Rust list (phone tools) refuses and passes the same sample paths', () => {
    const rs = readFileSync(resolve(__dirname, '../../../src-tauri/src/secret_paths.rs'), 'utf8')
    const block = (fn: string) => {
      const body = rs.slice(rs.indexOf(`fn ${fn}()`))
      const list = body.slice(body.indexOf('for p in ['), body.indexOf(']', body.indexOf('for p in [')))
      return [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\\\/g, '\\'))
    }
    const refused = block('the_paths_from_the_list_are_refused')
    const passed = block('ordinary_files_pass')
    expect(refused.length).toBeGreaterThan(10)
    for (const p of refused) expect(secretPathReason(p), `Rust refuses ${p}, TS must too`).toBeTruthy()
    for (const p of passed) expect(secretPathReason(p), `Rust passes ${p}, TS must too`).toBeNull()
  })
})
