/**
 * /local-api/fs-write-bytes: how a file attached in the chat reaches the
 * working folder when the app runs in a browser against `npm run dev`
 * (3.0.5). The parity port of the `fs_write_bytes` Tauri command, held to the
 * same promises: inside the jail, never over an existing file, complete or
 * absent, and capped.
 *
 * Real bytes, a real socket, a real file system, and the handler is the one
 * `registerFsRoutes` mounts for `npm run dev`.
 *
 * Run: npx vitest run dev-server/__tests__/datei-anhang-im-kaefig.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerFsRoutes } from '../fs-routes'
import { routeHolen } from './echte-anfrage'
import { anfrageImHeim, arbeitsordnerIn, frischesHeim, kulisseAufraeumen } from './kaefig-kulisse'
import { DEV_WRITE_BYTES_CAP } from '../../src/lib/dev-fs-jail'

let heim = ''
let ws = ''

beforeAll(() => {
  heim = frischesHeim()
  ws = arbeitsordnerIn(heim)
  mkdirSync(ws, { recursive: true })
})
afterAll(kulisseAufraeumen)

function put(body: Record<string, unknown>) {
  const handler = routeHolen(registerFsRoutes, '/local-api/fs-write-bytes')
  return anfrageImHeim(handler, heim, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')

describe('a binary lands byte for byte', () => {
  it('creates an empty attachment', async () => {
    const res = await put({ path: 'empty.bin', base64: '', offset: 0, last: true, workingDirectory: ws })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ status: 'saved', bytes: 0 })
    expect(readFileSync(join(ws, 'empty.bin')).length).toBe(0)
  })

  it('offset zero restarts an abandoned upload without old bytes', async () => {
    await put({ path: 'restart.bin', base64: b64([9, 9, 9]), offset: 0, last: false, workingDirectory: ws })
    const res = await put({ path: 'restart.bin', base64: b64([7]), offset: 0, last: true, workingDirectory: ws })
    expect(res.status).toBe(200)
    expect([...readFileSync(join(ws, 'restart.bin'))]).toEqual([7])
  })
  it('one chunk: bytes no text write would survive', async () => {
    const raw = [0x00, 0x0d, 0xff, 0xfe, 0x0a, 0x80, 0x4e, 0x45, 0x53, 0x1a]
    const res = await put({ path: 'game.nes', base64: b64(raw), offset: 0, last: true, workingDirectory: ws })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ status: 'saved', bytes: raw.length })
    expect([...readFileSync(join(ws, 'game.nes'))]).toEqual(raw)
    expect(existsSync(join(ws, '.game.nes.lu-part'))).toBe(false)
  })

  it('chunks are joined, and the file only appears with the last one', async () => {
    const first = await put({ path: 'rom.bin', base64: b64([1, 1, 1, 1]), offset: 0, last: false, workingDirectory: ws })
    expect(first.json()).toMatchObject({ status: 'partial', bytes: 4 })
    expect(existsSync(join(ws, 'rom.bin'))).toBe(false)
    const second = await put({ path: 'rom.bin', base64: b64([2, 2]), offset: 4, last: true, workingDirectory: ws })
    expect(second.json()).toMatchObject({ status: 'saved', bytes: 6 })
    expect([...readFileSync(join(ws, 'rom.bin'))]).toEqual([1, 1, 1, 1, 2, 2])
  })
})

describe('what it refuses', () => {
  it.each([-1, 0.5, 9007199254740992, '0', null])('rejects invalid offset %s before creating a stage', async (offset) => {
    const res = await put({ path: 'bad-offset.bin', base64: b64([1]), offset, last: true, workingDirectory: ws })
    expect(res.status).toBe(400)
    expect(res.text).toContain('Invalid upload offset')
    expect(existsSync(join(ws, 'bad-offset.bin'))).toBe(false)
  })
  it('a chunk at the wrong offset', async () => {
    await put({ path: 'order.bin', base64: b64([1, 1, 1, 1]), offset: 0, last: false, workingDirectory: ws })
    const res = await put({ path: 'order.bin', base64: b64([2]), offset: 2, last: true, workingDirectory: ws })
    expect(res.status).toBe(400)
    expect(res.text).toContain('out of order')
    expect(existsSync(join(ws, 'order.bin'))).toBe(false)
  })

  it('NEVER OVERWRITES: an existing file stays as it is', async () => {
    writeFileSync(join(ws, 'notes.txt'), 'the user\'s own file', 'utf8')
    const res = await put({ path: 'notes.txt', base64: b64([1, 2, 3]), offset: 0, last: true, workingDirectory: ws })
    expect(res.status).toBe(400)
    expect(res.text).toContain('already exists')
    expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toBe('the user\'s own file')
  })

  it('a path that climbs out of the workspace: 403, and nothing is written outside', async () => {
    const res = await put({ path: '../eingeschleust.bin', base64: b64([1]), offset: 0, last: true, workingDirectory: ws })
    expect(res.status).toBe(403)
    expect(existsSync(join(ws, '..', 'eingeschleust.bin'))).toBe(false)
    expect(existsSync(join(ws, '..', '.eingeschleust.bin.lu-part'))).toBe(false)
  })

  it('a request that names no file', async () => {
    const res = await put({ base64: b64([1]), offset: 0, last: true, workingDirectory: ws })
    expect(res.status).toBe(400)
    expect(res.text).toContain('Missing path')
  })

  it('broken base64 is an error, not an empty file', async () => {
    const res = await put({ path: 'broken.bin', base64: 'not base64 !!', offset: 0, last: true, workingDirectory: ws })
    expect(res.status).toBe(400)
    expect(res.text).toContain('Invalid base64')
    expect(existsSync(join(ws, 'broken.bin'))).toBe(false)
  })

  it('bytes past the cap', async () => {
    const res = await put({ path: 'huge.bin', base64: b64([1, 2, 3, 4]), offset: DEV_WRITE_BYTES_CAP, last: true, workingDirectory: ws })
    expect(res.status).toBe(400)
    expect(res.text).toContain('too large')
    expect(existsSync(join(ws, 'huge.bin'))).toBe(false)
  })
})
