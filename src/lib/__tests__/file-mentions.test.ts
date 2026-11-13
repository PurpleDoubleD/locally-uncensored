/**
 * U8: `@` file mentions. The trigger, the filter, the walk of the folder and
 * what a pick turns into: the same attachment a dropped file is, so the text
 * reaches the model as one delimited file block while the bubble keeps what
 * was typed. Secret files and binaries are refused with a short note.
 *
 * Run: npx vitest run src/lib/__tests__/file-mentions.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  MENTION_TEXT_CAP, buildMentionIndex, hasMentionToken, insertMention, loadMention, mentionAt, mentionIndexFor,
  mentionScore, rankMentions, removeMentionToken, __clearMentionCache,
  type FsCall, type MentionEntry,
} from '../file-mentions'
import { fileMessageFields, placeChatFiles } from '../chat-files'

/** A folder in memory, the way fs_list and fs_read answer for it. */
function fakeFs(tree: Record<string, string | null>, root = '/proj'): { fs: FsCall; calls: string[] } {
  const calls: string[] = []
  const fs = (async (command: string, args: Record<string, unknown>) => {
    const path = String(args.path)
    const abs = path === '.' ? root : path
    calls.push(`${command} ${abs}`)
    if (command === 'fs_list') {
      const prefix = `${abs}/`
      const names = new Map<string, boolean>()
      for (const key of Object.keys(tree)) {
        const full = `${root}/${key}`
        if (!full.startsWith(prefix)) continue
        const rest = full.slice(prefix.length)
        const [first, ...more] = rest.split('/')
        names.set(first, more.length > 0 || tree[key] === null)
      }
      return { entries: [...names].map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir, size: isDir ? 0 : (tree[`${abs.slice(root.length + 1) ? `${abs.slice(root.length + 1)}/` : ''}${name}`] ?? '').length, modified: 0 })) }
    }
    if (command === 'fs_read') {
      const rel = abs.slice(root.length + 1)
      const content = tree[rel]
      if (typeof content !== 'string') throw new Error('not found')
      if (content.startsWith('BINARY')) return { encoding: 'binary', bytes: 10 }
      return { encoding: 'utf8', content }
    }
    throw new Error(`unexpected ${command}`)
  }) as FsCall
  return { fs, calls }
}

const entry = (rel: string, isDir = false, depth = rel.split('/').length, modified = 0): MentionEntry =>
  ({ rel, abs: `/proj/${rel}`, isDir, size: 1, modified, depth })

beforeEach(() => __clearMentionCache())

describe('the trigger', () => {
  it('opens at the start and after whitespace, never inside a word', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('look at @src/ma', 15)).toEqual({ start: 8, query: 'src/ma' })
    expect(mentionAt('(@mat', 5)).toEqual({ start: 1, query: 'mat' })
    expect(mentionAt('mail name@host', 14)).toBeNull()
    expect(mentionAt('@src/math.ts done', 17)).toBeNull()
    expect(mentionAt('plain text', 10)).toBeNull()
  })

  it('follows the caret, not the end of the text', () => {
    expect(mentionAt('@ab then more', 3)).toEqual({ start: 0, query: 'ab' })
  })

  it('puts the token and a space in place of the typed query', () => {
    const at = mentionAt('see @ma please', 7)!
    expect(insertMention('see @ma please', at, 7, 'src/math.ts')).toEqual({ text: 'see @src/math.ts please', caret: 17 })
    const end = mentionAt('@m', 2)!
    expect(insertMention('@m', end, 2, 'my notes.md').text).toBe('@"my notes.md" ')
  })

  it('knows whether a token still stands, and takes it out', () => {
    expect(hasMentionToken('fix @src/math.ts now', 'src/math.ts')).toBe(true)
    expect(hasMentionToken('fix @src/math.ts.', 'src/math.ts')).toBe(true)
    expect(hasMentionToken('fix @src/math.tsx', 'src/math.ts')).toBe(false)
    expect(hasMentionToken('fix src/math.ts', 'src/math.ts')).toBe(false)
    expect(removeMentionToken('fix @src/math.ts now', 'src/math.ts')).toBe('fix now')
  })
})

describe('the filter', () => {
  it('ranks a name match above a fuzzy path match, and drops what does not match', () => {
    expect(mentionScore('math', 'src/math.ts')!).toBeGreaterThan(mentionScore('math', 'src/my-app/thing.ts') ?? -1)
    expect(mentionScore('xyz', 'src/math.ts')).toBeNull()
    expect(mentionScore('smt', 'src/math.ts')).not.toBeNull()
  })

  it('shows shallow and recent first without a query, and at most the limit', () => {
    const rows = rankMentions([entry('a/b/c/deep.ts', false, 4), entry('README.md', false, 1, 5), entry('index.ts', false, 1, 9)], '')
    expect(rows.map((r) => r.rel)).toEqual(['index.ts', 'README.md', 'a/b/c/deep.ts'])
    const many = Array.from({ length: 120 }, (_, i) => entry(`f${i}.ts`))
    expect(rankMentions(many, 'f')).toHaveLength(50)
  })
})

describe('reading the folder', () => {
  it('walks breadth first and never lists node_modules, .git or dist', async () => {
    const { fs, calls } = fakeFs({
      'src/math.ts': 'x', 'src/lib/deep.ts': 'y', 'README.md': 'r',
      'node_modules/react/index.js': 'z', '.git/HEAD': 'h', 'dist/app.js': 'd',
    })
    const index = await buildMentionIndex({ workingDirectory: '/proj' }, fs)
    const rels = index.entries.map((e) => e.rel)
    expect(rels).toEqual(expect.arrayContaining(['src', 'src/math.ts', 'src/lib', 'src/lib/deep.ts', 'README.md']))
    expect(rels.some((r) => /node_modules|\.git|dist/.test(r))).toBe(false)
    expect(calls.some((c) => c.includes('node_modules'))).toBe(false)
    expect(index.entries.find((e) => e.rel === 'README.md')!.depth).toBeLessThan(index.entries.find((e) => e.rel === 'src/lib/deep.ts')!.depth)
  })

  it('reads a root once while the cache is fresh', async () => {
    const { fs, calls } = fakeFs({ 'a.ts': 'a' })
    await mentionIndexFor({ workingDirectory: '/proj' }, fs, 1000)
    await mentionIndexFor({ workingDirectory: '/proj' }, fs, 2000)
    expect(calls.filter((c) => c.startsWith('fs_list'))).toHaveLength(1)
  })
})

describe('a pick becomes an attachment', () => {
  const root = { workingDirectory: '/proj' }

  it('carries path and content to the model, while the bubble shows what was typed', async () => {
    const { fs } = fakeFs({ 'src/math.ts': 'export const add = (a, b) => a + b\n' })
    const result = await loadMention(root, entry('src/math.ts'), fs)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.mention).toBe('src/math.ts')
    expect(result.input.attachment).toMatchObject({ name: 'src/math.ts', workspacePath: 'src/math.ts', textChars: 35 })
    // Already in the folder: the send never copies it again.
    const placed = await placeChatFiles([result.input], { chatId: 'c1' })
    expect(placed.failed).toEqual([])
    const fields = fileMessageFields('@src/math.ts why is this slow?', placed.files, 'workspace')
    expect(fields.displayContent).toBe('@src/math.ts why is this slow?')
    expect(fields.content).toContain('[Attached file: src/math.ts]')
    expect(fields.content).toContain('Path in your working folder: src/math.ts')
    expect(fields.content).toContain('export const add = (a, b) => a + b')
    expect(fields.content).toContain('[End of attached file: src/math.ts]')
    expect(fields.files![0].name).toBe('src/math.ts')
  })

  it('cuts a long text at the cap and says so', async () => {
    const big = 'a'.repeat(MENTION_TEXT_CAP + 500)
    const { fs } = fakeFs({ 'big.txt': big })
    const result = await loadMention(root, entry('big.txt'), fs)
    if (!result.ok) throw new Error('expected ok')
    expect(result.input.attachment.includedChars).toBe(MENTION_TEXT_CAP)
    expect(result.input.attachment.textChars).toBe(big.length)
    expect(result.input.attachment.summary).toMatch(/^Only the first 65,536 of 66,036 characters/)
  })

  it('refuses a binary with a short note', async () => {
    const { fs, calls } = fakeFs({ 'logo.png': 'BINARY', 'blob.dat': 'BINARY', 'nul.txt': 'a\u0000b' })
    expect(await loadMention(root, entry('logo.png'), fs)).toEqual({ ok: false, note: 'logo.png is not a text file, so it was not attached. Use the clip to attach it instead.' })
    // By its ending: not even read.
    expect(calls).toEqual([])
    expect((await loadMention(root, entry('blob.dat'), fs)).ok).toBe(false)
    expect((await loadMention(root, entry('nul.txt'), fs)).ok).toBe(false)
  })

  it('refuses secret files with the C59 rules, before anything is read', async () => {
    const { fs, calls } = fakeFs({ '.env': 'KEY=1', 'config/.env.local': 'K=2', 'certs/server.pem': 'x', '.ssh/id_rsa': 'k', '.env.example': 'KEY=' })
    for (const rel of ['.env', 'config/.env.local', 'certs/server.pem', '.ssh/id_rsa']) {
      const result = await loadMention(root, entry(rel), fs)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.note).toMatch(/stays private: it holds .+\. LU never sends secret files to a model\./)
    }
    expect(calls).toEqual([])
    // The examples projects ship are fine.
    expect((await loadMention(root, entry('.env.example'), fs)).ok).toBe(true)
  })

  it('turns a folder into a short listing, without the ignored folders and secret files', async () => {
    const { fs } = fakeFs({ 'src/math.ts': 'x', 'src/util/a.ts': 'y', 'src/node_modules/z.js': 'z', 'src/.env': 'K=1' })
    const result = await loadMention(root, entry('src', true), fs)
    if (!result.ok) throw new Error('expected ok')
    expect(result.input.mention).toBe('src/')
    expect(result.input.attachment).toMatchObject({ name: 'src/', kind: 'Folder listing', workspacePath: 'src/' })
    const summary = result.input.attachment.summary
    expect(summary).toContain('util/')
    expect(summary).toContain('math.ts (1 bytes)')
    expect(summary).not.toContain('node_modules')
    expect(summary).not.toContain('.env')
  })
})
