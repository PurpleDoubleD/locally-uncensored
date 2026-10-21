import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeUploadChunk } from '../upload-staging'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, linkSync: vi.fn(actual.linkSync), readSync: vi.fn(actual.readSync), fsyncSync: vi.fn(actual.fsyncSync) }
})

const roots: string[] = []
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
afterEach(() => {
  vi.mocked(linkSync).mockImplementation(actualFs.linkSync)
  vi.mocked(readSync).mockImplementation(actualFs.readSync)
  vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync)
})
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lu-upload-test-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  return { root, workspace, target: join(workspace, 'rom.bin') }
}

const canSymlink = (() => {
  const { root } = fixture()
  try { symlinkSync(join(root, 'missing'), join(root, 'probe')); return true }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
})()

function stage(workspace: string): string {
  const directory = readdirSync(workspace).find((name) => name.startsWith('.lu-upload-'))
  if (!directory) throw new Error('Expected an owned upload staging directory')
  return join(workspace, directory, 'bytes')
}

describe('an untrusted workspace cannot choose an attachment staging inode', () => {
  for (const kind of ['symlink', 'hardlink'] as const) it.skipIf(kind === 'symlink' && !canSymlink)(`ignores a preexisting legacy ${kind} at first and later chunks`, () => {
    const { root, workspace, target } = fixture()
    const victim = join(root, 'outside.txt')
    writeFileSync(victim, 'outside unchanged')
    const legacy = join(workspace, '.rom.bin.lu-part')
    if (kind === 'symlink') symlinkSync(victim, legacy)
    else actualFs.linkSync(victim, legacy)
    writeUploadChunk(target, Buffer.from('a'), 0, false)
    writeUploadChunk(target, Buffer.from('b'), 1, true)
    expect(readFileSync(target, 'utf8')).toBe('ab')
    expect(readFileSync(victim, 'utf8')).toBe('outside unchanged')
  })

  it('does not adopt an existing partial file when the upload never started', () => {
    const { root, workspace, target } = fixture()
    const victim = join(root, 'outside.txt')
    writeFileSync(victim, 'outside')
    actualFs.linkSync(victim, join(workspace, '.rom.bin.lu-part'))
    expect(() => writeUploadChunk(target, Buffer.from('!'), 7, true)).toThrow('out of order')
    expect(readFileSync(victim, 'utf8')).toBe('outside')
  })

  for (const kind of ['symlink', 'hardlink', 'file'] as const) it.skipIf(kind === 'symlink' && !canSymlink)(`rejects a stage replaced with a ${kind} between chunks`, () => {
    const { root, workspace, target } = fixture()
    const victim = join(root, 'outside.txt')
    writeFileSync(victim, 'outside unchanged')
    writeUploadChunk(target, Buffer.from('prefix'), 0, false)
    const partial = stage(workspace)
    unlinkSync(partial)
    if (kind === 'symlink') symlinkSync(victim, partial)
    else if (kind === 'hardlink') actualFs.linkSync(victim, partial)
    else writeFileSync(partial, 'forged')
    expect(() => writeUploadChunk(target, Buffer.from('private attachment'), 6, true)).toThrow('staging file was changed')
    expect(readFileSync(victim, 'utf8')).toBe('outside unchanged')
    expect(existsSync(target)).toBe(false)
  })

  it('rejects a new hardlink to its owned stage before appending', () => {
    const { root, workspace, target } = fixture()
    writeUploadChunk(target, Buffer.from('prefix'), 0, false)
    const alias = join(root, 'outside-alias')
    actualFs.linkSync(stage(workspace), alias)
    expect(() => writeUploadChunk(target, Buffer.from('private'), 6, true)).toThrow('staging file was changed')
    expect(readFileSync(alias, 'utf8')).toBe('prefix')
    expect(existsSync(target)).toBe(false)
  })

  it('prevents or rejects replacing a staging directory without deleting unexpected entries', () => {
    const { root, workspace, target } = fixture()
    writeUploadChunk(target, Buffer.from('prefix'), 0, false)
    const directory = join(stage(workspace), '..')
    try { renameSync(directory, join(root, 'moved-stage')) }
    catch (error) {
      // Windows can lock the directory against renaming while the retained
      // child handle is open. That prevents this substitution at the OS.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      writeUploadChunk(target, Buffer.from('private'), 6, true)
      expect(readFileSync(target, 'utf8')).toBe('prefixprivate')
      return
    }
    mkdirSync(directory)
    writeFileSync(join(directory, 'bytes'), 'forged')
    expect(() => writeUploadChunk(target, Buffer.from('private'), 6, true)).toThrow('staging file was changed')
    expect(readFileSync(join(directory, 'bytes'), 'utf8')).toBe('forged')
    expect(existsSync(target)).toBe(false)
  })
})

describe('no-clobber publication', () => {
  it('preserves a destination created at the publication boundary', () => {
    const { target } = fixture()
    vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
      writeFileSync(destination, 'existing project file')
      actualFs.linkSync(source, destination)
    })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('already exists')
    expect(readFileSync(target, 'utf8')).toBe('existing project file')
  })

  it.skipIf(!canSymlink)('never replaces a dangling destination symlink', () => {
    const { root, target } = fixture()
    const missing = join(root, 'missing-outside')
    symlinkSync(missing, target)
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('already exists')
    expect(actualFs.lstatSync(target).isSymbolicLink()).toBe(true)
    expect(existsSync(missing)).toBe(false)
  })

  it('detects a source pathname substituted exactly before publication', () => {
    const { root, target } = fixture()
    const victim = join(root, 'outside.txt')
    writeFileSync(victim, 'outside unchanged')
    vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
      unlinkSync(source)
      actualFs.linkSync(victim, source)
      actualFs.linkSync(source, destination)
    })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('staging file was changed')
    expect(readFileSync(victim, 'utf8')).toBe('outside unchanged')
    expect(existsSync(target)).toBe(false)
  })

  it('bounds abandoned descriptors and expires stale uploads on the next request', () => {
    const { workspace } = fixture()
    for (let i = 0; i < 70; i++) writeUploadChunk(join(workspace, `${i}.bin`), Buffer.from('a'), 0, false)
    expect(readdirSync(workspace).filter((name) => name.startsWith('.lu-upload-')).length).toBeLessThanOrEqual(64)
    expect(() => writeUploadChunk(join(workspace, '0.bin'), Buffer.from('b'), 1, true)).toThrow('out of order')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000)
    try {
      writeUploadChunk(join(workspace, 'finished.bin'), Buffer.from('done'), 0, true)
      expect(readdirSync(workspace)).toEqual(['finished.bin'])
    } finally { clock.mockRestore() }
  })
})

describe('filesystems without hard links', () => {
  function unsupported(code = 'ENOTSUP'): NodeJS.ErrnoException {
    return Object.assign(new Error('hard links unsupported by filesystem'), { code })
  }

  it.each(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EISDIR', 'EINVAL'])('copies from retained handles when link fails with %s', (code) => {
    const { workspace, target } = fixture()
    const first = Buffer.alloc(1024 * 1024 + 23, 0xa5)
    writeUploadChunk(target, first, 0, false)
    expect(existsSync(target)).toBe(false)
    vi.mocked(linkSync).mockImplementationOnce(() => { throw unsupported(code) })
    writeUploadChunk(target, Buffer.from([0, 255, 13]), first.length, true)
    expect(readFileSync(target)).toEqual(Buffer.concat([first, Buffer.from([0, 255, 13])]))
    expect(readdirSync(workspace)).toEqual(['rom.bin'])
  })

  it('creates an empty file through the fallback', () => {
    const { target } = fixture()
    vi.mocked(linkSync).mockImplementationOnce(() => { throw unsupported() })
    writeUploadChunk(target, Buffer.alloc(0), 0, true)
    expect(readFileSync(target).length).toBe(0)
  })

  it('preserves a destination created before the exclusive fallback open', () => {
    const { target } = fixture()
    vi.mocked(linkSync).mockImplementationOnce(() => {
      writeFileSync(target, 'existing project file')
      throw unsupported()
    })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('already exists')
    expect(readFileSync(target, 'utf8')).toBe('existing project file')
  })

  it('preserves an existing hardlink destination', () => {
    const { root, target } = fixture()
    const victim = join(root, 'outside.txt')
    writeFileSync(victim, 'outside unchanged')
    actualFs.linkSync(victim, target)
    vi.mocked(linkSync).mockImplementationOnce(() => { throw unsupported() })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('already exists')
    expect(readFileSync(victim, 'utf8')).toBe('outside unchanged')
    expect(readFileSync(target, 'utf8')).toBe('outside unchanged')
  })

  it.skipIf(!canSymlink)('preserves a dangling symlink destination', () => {
    const { root, target } = fixture()
    const missing = join(root, 'outside-missing')
    symlinkSync(missing, target)
    vi.mocked(linkSync).mockImplementationOnce(() => { throw unsupported() })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('already exists')
    expect(actualFs.lstatSync(target).isSymbolicLink()).toBe(true)
    expect(existsSync(missing)).toBe(false)
  })

  it('removes its exclusive partial destination after a read failure', () => {
    const { workspace, target } = fixture()
    vi.mocked(linkSync).mockImplementationOnce(() => { throw unsupported() })
    vi.mocked(readSync).mockImplementationOnce(() => { throw new Error('injected read failure') })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('injected read failure')
    expect(readdirSync(workspace)).toEqual([])
  })

  it('removes its destination after a final flush failure', () => {
    const { workspace, target } = fixture()
    vi.mocked(linkSync).mockImplementationOnce(() => { throw unsupported() })
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('injected flush failure') })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('injected flush failure')
    expect(readdirSync(workspace)).toEqual([])
  })

  it('does not delete a replacement destination while cleaning up a failed copy', () => {
    const { target } = fixture()
    vi.mocked(linkSync).mockImplementationOnce(() => { throw unsupported() })
    vi.mocked(readSync).mockImplementationOnce(() => {
      unlinkSync(target)
      writeFileSync(target, 'replacement belongs to someone else')
      throw new Error('injected read failure after replacement')
    })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('injected read failure')
    expect(readFileSync(target, 'utf8')).toBe('replacement belongs to someone else')
  })

  it('rejects a stage substituted before the copy fallback and leaves its victim intact', () => {
    const { root, target } = fixture()
    const victim = join(root, 'outside.txt')
    writeFileSync(victim, 'outside unchanged')
    vi.mocked(linkSync).mockImplementationOnce((source) => {
      unlinkSync(source)
      actualFs.linkSync(victim, source)
      throw unsupported()
    })
    expect(() => writeUploadChunk(target, Buffer.from('attachment'), 0, true)).toThrow('staging file was changed')
    expect(readFileSync(victim, 'utf8')).toBe('outside unchanged')
    expect(existsSync(target)).toBe(false)
  })
})
