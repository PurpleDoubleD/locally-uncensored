/**
 * Hugging Face "Use this model" (B17): the page's second lock on what the
 * inbox hands out, and the file the dialog offers. The first lock is in Rust
 * (src-tauri/src/hf_link.rs, `cargo test hf_link`), with the same bad inputs.
 *
 * Run: npx vitest run src/lib/__tests__/hf-link.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  choiceForFile, defaultChoice, ggufChoicesFromTree, isValidGgufPath, isValidRepoId, linkModel, readInbound, sizeLabel,
} from '../hf-link'
import { selectGgufFromTree, type HfTreeEntry } from '../../api/discover'

const MB = 1_048_576
const tree: HfTreeEntry[] = [
  { type: 'directory', path: 'Q8_0' },
  { type: 'file', path: 'README.md', size: 10 },
  { type: 'file', path: 'tiny-Q4_K_M.gguf', size: 400 * MB },
  { type: 'file', path: 'tiny-Q8_0.gguf', size: 700 * MB },
  { type: 'file', path: 'mmproj-tiny-F16.gguf', size: 90 * MB },
  { type: 'file', path: 'big/big-Q4_K_M-00002-of-00002.gguf', size: 1000 * MB },
  { type: 'file', path: 'big/big-Q4_K_M-00001-of-00002.gguf', size: 1000 * MB },
  { type: 'file', path: 'model.safetensors', size: 1000 * MB },
]

describe('the second lock on the inbox', () => {
  it('passes what Rust passes', () => {
    expect(readInbound({ kind: 'model', repo: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF', file: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf' }))
      .toEqual({ kind: 'model', link: { repo: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF', file: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf' } })
    expect(readInbound({ kind: 'model', repo: 'a/b', file: null })).toEqual({ kind: 'model', link: { repo: 'a/b', file: null } })
    expect(readInbound({ kind: 'model', repo: 'a/b' })).toEqual({ kind: 'model', link: { repo: 'a/b', file: null } })
  })

  it.each([
    'a', 'a/b/c', '/b', 'a/', '../b', 'a/..', 'a/b..c', 'a--x/b', '-a/b', 'a/b-', '.a/b', 'a/b.', 'a b/c',
    'a/b\u0000', 'a/b\n', 'a\\b/c', 'https://evil.example/a/b', 'a/b?x=1', 'a/\u202eb', 'a/<script>', `${'a'.repeat(97)}/b`,
  ])('refuses repo %j', (repo) => {
    expect(isValidRepoId(repo)).toBe(false)
    expect(readInbound({ kind: 'model', repo, file: null })).toBeNull()
  })

  it.each([
    'model.bin', 'model.safetensors', 'model.gguf.exe', 'model.gguf\u0000.exe', '.gguf', 'dir/.gguf', '../model.gguf',
    'dir/../../model.gguf', './model.gguf', '/model.gguf', 'dir//model.gguf', '.hidden.gguf', 'dir\\model.gguf',
    'C:\\model.gguf', 'model\n.gguf', 'my model.gguf', 'mod\u00e9l.gguf', 'a/b/c/d/e/f/g/h/i.gguf', `${'m'.repeat(251)}.gguf`,
  ])('refuses file %j', (file) => {
    expect(isValidGgufPath(file)).toBe(false)
    expect(readInbound({ kind: 'model', repo: 'a/b', file })).toBeNull()
  })

  it('refuses shapes that are not the inbox', () => {
    for (const raw of [null, undefined, 'locallyuncensored://open-model?repo=a/b', 42, [], { kind: 'download', repo: 'a/b' }, { kind: 'model', repo: 7 }, { kind: 'model', repo: 'a/b', file: 3 }]) {
      expect(readInbound(raw)).toBeNull()
    }
  })

  it('shows a rejection as the sentence Rust gave, never a long or foreign one', () => {
    expect(readInbound({ kind: 'rejected', reason: 'The link does not name a GGUF file.' }))
      .toEqual({ kind: 'rejected', reason: 'The link does not name a GGUF file.' })
    expect(readInbound({ kind: 'rejected', reason: 'x'.repeat(500) })).toEqual({ kind: 'rejected', reason: 'The link could not be read.' })
    expect(readInbound({ kind: 'rejected' })).toEqual({ kind: 'rejected', reason: 'The link could not be read.' })
  })
})

describe('the file the dialog offers', () => {
  const choices = ggufChoicesFromTree(tree)

  it('lists model files and split sets, smallest first, without image parts', () => {
    expect(choices).toEqual([
      { path: 'tiny-Q4_K_M.gguf', quant: 'Q4_K_M', bytes: 400 * MB, parts: 1 },
      { path: 'tiny-Q8_0.gguf', quant: 'Q8_0', bytes: 700 * MB, parts: 1 },
      { path: 'big/big-Q4_K_M-00001-of-00002.gguf', quant: 'Q4_K_M', bytes: 2000 * MB, parts: 2 },
    ])
    expect(ggufChoicesFromTree({ error: 'Repository not found' })).toEqual([])
  })

  it('takes the named file by its full path and nothing else', () => {
    expect(choiceForFile(choices, 'tiny-Q8_0.gguf')?.path).toBe('tiny-Q8_0.gguf')
    expect(choiceForFile(choices, 'big/big-Q4_K_M-00002-of-00002.gguf')?.parts).toBe(2)
    // No guessing: not by leaf name, not by quant, not an image part.
    expect(choiceForFile(choices, 'other/tiny-Q8_0.gguf')).toBeNull()
    expect(choiceForFile(choices, 'tiny-Q5_K_M.gguf')).toBeNull()
    expect(choiceForFile(choices, 'mmproj-tiny-F16.gguf')).toBeNull()
  })

  it('preselects Q4_K_M when the link names no file', () => {
    expect(defaultChoice(choices)?.path).toBe('tiny-Q4_K_M.gguf')
    expect(defaultChoice([])).toBeNull()
  })

  it('builds the entry for the download from huggingface.co only', () => {
    const one = selectGgufFromTree(tree, 'a/b', undefined, 'tiny-Q8_0.gguf')!
    expect(linkModel('a/b', one)).toMatchObject({
      name: 'tiny-Q8_0',
      downloadUrl: 'https://huggingface.co/a/b/resolve/main/tiny-Q8_0.gguf',
      filename: 'tiny-Q8_0.gguf',
      sizeBytes: 700 * MB,
    })
    const split = selectGgufFromTree(tree, 'a/b', undefined, 'big/big-Q4_K_M-00001-of-00002.gguf')!
    expect(linkModel('a/b', split)).toMatchObject({ name: 'big-Q4_K_M', filename: 'big-Q4_K_M-00001-of-00002.gguf', sizeBytes: undefined })
    expect(linkModel('a/b', { ...one, files: [{ ...one.files[0], url: 'https://evil.example/a/b/resolve/main/tiny-Q8_0.gguf' }] })).toBeNull()
    expect(linkModel('c/d', one)).toBeNull()
  })

  it('reads sizes the way the dialog prints them', () => {
    expect(sizeLabel(400 * MB)).toBe('400 MB')
    expect(sizeLabel(2000 * MB)).toBe('2.0 GB')
    expect(sizeLabel(0)).toBe('size unknown')
  })
})
