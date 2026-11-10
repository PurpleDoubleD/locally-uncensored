/**
 * C59: two places where the browser dev server answered differently from the
 * app, found by the agent bench (it runs against this server).
 *
 * 1. fs-read of a missing file answered 200 with an `error` field, and
 *    file_read turned that into an empty text. Rust's fs_read returns an
 *    error. A 9B took the missing file for an empty one, made up numbers and
 *    wrote them into it.
 * 2. shell-execute ran in the Vite process folder (the repo) when the model
 *    sent no cwd. Rust runs in the workspace, and a relative cwd inside it.
 *
 * Run: npx vitest run dev-server/__tests__/dev-bank-wie-die-app.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerFsRoutes } from '../fs-routes'
import { devShellCwd } from '../exec-routes'
import { AGENT_WORKSPACE_DIR } from '../../src/lib/app-identity'
import { routeHolen } from './echte-anfrage'
import { anfrageImHeim, arbeitsordnerIn, frischesHeim, kulisseAufraeumen } from './kaefig-kulisse'

afterAll(kulisseAufraeumen)

function lesen(koerper: Record<string, unknown>, heim: string) {
  return anfrageImHeim(routeHolen(registerFsRoutes, '/local-api/fs-read'), heim, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(koerper),
  })
}

describe('fs-read like fs_read in Rust', () => {
  it('a missing file is a 404 with "File not found", not an empty text', async () => {
    const heim = frischesHeim()
    const ws = arbeitsordnerIn(heim)
    const res = await lesen({ path: 'daten/werte.txt', workingDirectory: ws }, heim)
    expect(res.status).toBe(404)
    expect((res.json() as { error?: string }).error).toBe('File not found: daten/werte.txt')
  })

  it('a file that is there still reads', async () => {
    const heim = frischesHeim()
    const ws = arbeitsordnerIn(heim)
    mkdirSync(join(ws, 'data'), { recursive: true })
    writeFileSync(join(ws, 'data', 'werte.txt'), '12\n7\n')
    const res = await lesen({ path: 'data/werte.txt', workingDirectory: ws }, heim)
    expect(res.status).toBe(200)
    expect((res.json() as { content?: string }).content).toBe('12\n7\n')
  })
})

describe('the folder a dev shell command runs in', () => {
  const same = (a: string, b: string) => expect(realpathSync(a)).toBe(realpathSync(b))

  it('the workspace without a cwd, never the Vite folder', () => {
    const heim = frischesHeim()
    const ws = arbeitsordnerIn(heim)
    same(devShellCwd(undefined, 'c1', ws, heim), ws)
    expect(realpathSync(devShellCwd(undefined, 'c1', ws, heim))).not.toBe(realpathSync(process.cwd()))
  })

  it('a relative cwd inside the workspace, a missing one falls back to it', () => {
    const heim = frischesHeim()
    const ws = arbeitsordnerIn(heim)
    mkdirSync(join(ws, 'fotos'), { recursive: true })
    same(devShellCwd('fotos', 'c1', ws, heim), join(ws, 'fotos'))
    same(devShellCwd('fehlt', 'c1', ws, heim), ws)
  })

  it('without a folder workspace: the chat sandbox under the home', () => {
    const heim = frischesHeim()
    same(devShellCwd('', 'mein-chat', undefined, heim), join(heim, AGENT_WORKSPACE_DIR, 'mein-chat'))
  })
})

describe('the bench fence (C59, Zentrale 09.11.2026)', () => {
  it('off unless the bench asks for it, refused rather than unfenced where there is no sandbox', async () => {
    const { fenceShell } = await import('../bench-sandbox')
    expect(fenceShell('bash', ['-c', 'ls'], {})).toEqual({ bin: 'bash', args: ['-c', 'ls'] })
    expect(fenceShell('bash', ['-c', 'ls'], { LU_BENCH_SANDBOX: '1' }, 'linux')).toHaveProperty('refused')
  })

  it.runIf(process.platform === 'darwin')('a fenced command cannot read or list the real home folder, node still runs', async () => {
    const { fenceShell } = await import('../bench-sandbox')
    const { spawnSync } = await import('node:child_process')
    const os = await import('node:os')
    const home = os.userInfo().homedir
    const run = (cmd: string) => {
      const f = fenceShell('/bin/bash', ['-c', cmd], { LU_BENCH_SANDBOX: '1' })
      if ('refused' in f) throw new Error(f.refused)
      return spawnSync(f.bin, f.args, { encoding: 'utf8' })
    }
    const ls = run(`ls ${JSON.stringify(home + '/Desktop')}`)
    expect(ls.status).not.toBe(0)
    expect(ls.stderr).toMatch(/Operation not permitted/)
    const write = run(`echo x > ${JSON.stringify(home + '/c59-fence-probe.txt')}`)
    expect(write.status).not.toBe(0)
    expect(run(`${JSON.stringify(process.execPath)} -e "console.log(6*7)"`).stdout.trim()).toBe('42')
  })

  it('the file tools are already caged: an absolute path outside the workspace is refused', async () => {
    const heim = frischesHeim()
    const ws = arbeitsordnerIn(heim)
    const draussen = join(heim, 'Desktop', 'privat.txt')
    mkdirSync(join(heim, 'Desktop'), { recursive: true })
    writeFileSync(draussen, 'nicht für den Agenten')
    const res = await lesen({ path: draussen, workingDirectory: ws }, heim)
    expect(res.status).toBe(403)
    const rel = await lesen({ path: '../Desktop/privat.txt', workingDirectory: ws }, heim)
    expect(rel.status).toBe(403)
  })
})
