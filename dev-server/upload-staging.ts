import {
  closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, realpathSync, rmdirSync, unlinkSync, writeSync,
  type Stats,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const MAX_UPLOADS = 64
const IDLE_MS = 30 * 60 * 1000

interface Upload {
  directory: string
  path: string
  fd: number
  identity: Stats
  directoryIdentity: Stats
  touched: number
}

// State belongs to the process, not to a request or a reconstructed route mount.
const uploads = new Map<string, Upload>()
const keyFor = (target: string) => process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target)
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino

function dispose(upload: Upload): void {
  try { closeSync(upload.fd) } catch { /* Already closed after an I/O failure. */ }
  // Never recursively remove a directory whose contents a workspace can change.
  try {
    const directory = lstatSync(upload.directory)
    if (!directory.isDirectory() || !sameFile(directory, upload.directoryIdentity)) return
    try { unlinkSync(upload.path) } catch { /* Removed or replaced during the upload. */ }
    try { rmdirSync(upload.directory) } catch { /* Leave unexpected entries untouched. */ }
  } catch { /* An abandoned directory may already have been removed. */ }
}

function forget(key: string): void {
  const upload = uploads.get(key)
  if (upload) { uploads.delete(key); dispose(upload) }
}

function prune(now: number): void {
  for (const [key, upload] of uploads) if (now - upload.touched > IDLE_MS) forget(key)
}

function assertOwned(upload: Upload, links: number): Stats {
  const directory = lstatSync(upload.directory)
  const path = lstatSync(upload.path)
  const file = fstatSync(upload.fd)
  if (!directory.isDirectory() || !sameFile(directory, upload.directoryIdentity)
    || !path.isFile() || !sameFile(path, upload.identity)
    || !sameFile(file, upload.identity) || file.nlink !== links || path.nlink !== links) {
    throw new Error('Upload staging file was changed; restart the upload')
  }
  return file
}

function unlinkIfOwned(target: string, identity: Stats): void {
  try {
    if (sameFile(lstatSync(target), identity)) unlinkSync(target)
  } catch { /* Removed/replaced paths are not ours to clean up. */ }
}

function assertDestination(target: string, fd: number, identity: Stats): void {
  const entry = lstatSync(target)
  const file = fstatSync(fd)
  if (!entry.isFile() || !sameFile(entry, identity) || !sameFile(file, identity)
    || entry.nlink !== 1 || file.nlink !== 1) {
    throw new Error('Upload destination was changed during publication')
  }
}

function copyToExclusiveDestination(upload: Upload, target: string): void {
  const size = assertOwned(upload, 1).size
  let fd: number
  try { fd = openSync(target, 'wx+', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`File already exists: ${target}`)
    throw error
  }
  let identity: Stats | undefined
  try {
    identity = fstatSync(fd)
    assertDestination(target, fd, identity)
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size || 1))
    let position = 0
    while (position < size) {
      assertOwned(upload, 1)
      assertDestination(target, fd, identity)
      const count = readSync(upload.fd, buffer, 0, Math.min(buffer.length, size - position), position)
      if (count === 0) throw new Error('Write error: attachment ended before all upload bytes were copied')
      let written = 0
      while (written < count) {
        const bytes = writeSync(fd, buffer, written, count - written, position + written)
        if (bytes === 0) throw new Error('Write error: no attachment bytes were copied')
        written += bytes
      }
      position += count
    }
    assertOwned(upload, 1)
    assertDestination(target, fd, identity)
    fsyncSync(fd)
  } catch (error) {
    // An exclusive open owns this inode, not a later replacement at its name.
    // Keep the handle open through identity-checked cleanup on every platform.
    if (identity) unlinkIfOwned(target, identity)
    throw error
  } finally { closeSync(fd) }
}

function cannotHardlink(error: unknown): boolean {
  // EISDIR/EINVAL can also represent a driver's unsupported link operation;
  // exclusive creation still rejects a real directory or any existing entry.
  return ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EISDIR', 'EINVAL'].includes((error as NodeJS.ErrnoException).code || '')
}

/**
 * A selected workspace may contain hostile names and links. New uploads use an
 * exclusive file in a fresh private directory and never reopen a workspace
 * partial file. Identity/link checks also reject substitutions between chunks.
 *
 * Like the surrounding filesystem jail, portable pathname operations do not
 * isolate a continuously racing process running as the same OS user. The random
 * private directory is the boundary against a prearranged malicious workspace;
 * verification before and after publication must not be described as an atomic
 * defense against that stronger local-process attacker.
 *
 * Hard-link publication exposes a complete file atomically. FAT/exFAT and
 * filesystems that forbid links use an exclusive destination handle and copy
 * from the retained source handle instead. That destination is visible during
 * the final copy; handled failures remove the owned partial file, while an
 * abrupt process/OS crash can leave it. Existing entries are never overwritten.
 */
export function writeUploadChunk(target: string, bytes: Buffer, offset: number, last: boolean): number {
  const key = keyFor(target)
  const now = Date.now()
  prune(now)
  if (offset === 0) {
    forget(key) // A first chunk deliberately restarts an abandoned upload.
    while (uploads.size >= MAX_UPLOADS) forget(uploads.keys().next().value!)
    mkdirSync(dirname(target), { recursive: true })
    const directory = mkdtempSync(join(realpathSync(dirname(target)), '.lu-upload-'))
    let fd: number
    try { fd = openSync(join(directory, 'bytes'), 'wx+', 0o600) }
    catch (error) { try { rmdirSync(directory) } catch { /* Best effort. */ } throw error }
    try {
      uploads.set(key, {
        directory, path: join(directory, 'bytes'), fd,
        identity: fstatSync(fd), directoryIdentity: lstatSync(directory), touched: now,
      })
    } catch (error) {
      closeSync(fd)
      try { unlinkSync(join(directory, 'bytes')); rmdirSync(directory) } catch { /* Best effort. */ }
      throw error
    }
  }
  const upload = uploads.get(key)
  if (!upload) throw new Error(`Upload out of order: expected the chunk at byte 0, got the one at byte ${offset}`)
  try {
    const have = assertOwned(upload, 1).size
    if (have !== offset) {
      // A bad/repeated chunk leaves the good prefix available for a retry.
      throw new UploadOrderError(`Upload out of order: expected the chunk at byte ${have}, got the one at byte ${offset}`)
    }
    let written = 0
    while (written < bytes.length) {
      const count = writeSync(upload.fd, bytes, written, bytes.length - written, offset + written)
      if (count === 0) throw new Error('Write error: no upload bytes were written')
      written += count
    }
    upload.touched = now
    if (!last) return offset + bytes.length
    assertOwned(upload, 1)
    try {
      // link() creates the complete destination atomically and NEVER replaces
      // any existing entry, including a dangling symlink. No rename fallback.
      linkSync(upload.path, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`File already exists: ${target}`)
      if (cannotHardlink(error)) {
        copyToExclusiveDestination(upload, target)
        forget(key)
        return offset + bytes.length
      }
      throw error
    }
    const publishedIdentity = lstatSync(target)
    try {
      const destination = publishedIdentity
      if (!destination.isFile() || !sameFile(destination, upload.identity)) {
        throw new Error('Upload staging file was changed during publication')
      }
      assertOwned(upload, 2)
    } catch (error) {
      // Only unlink the entry this link() published, never follow its content.
      unlinkIfOwned(target, publishedIdentity)
      throw error
    }
    forget(key)
    return offset + bytes.length
  } catch (error) {
    if (!(error instanceof UploadOrderError)) forget(key)
    throw error
  }
}

class UploadOrderError extends Error {}

// Closing the process closes descriptors; this also removes ordinary abandoned
// stages on a clean shutdown. Stale stages after a crash are never adopted.
process.once('exit', () => { for (const key of uploads.keys()) forget(key) })
