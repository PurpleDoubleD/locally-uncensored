import { describe, it, expect, beforeEach } from 'vitest'
import {
  setActiveChatId,
  getActiveChatId,
  clearActiveChatId,
  chatWorkspaceSlug,
} from '../agent-context'

describe('agent-context › setActiveChatId / getActiveChatId', () => {
  beforeEach(() => clearActiveChatId())

  it('starts unset', () => {
    expect(getActiveChatId()).toBeNull()
  })

  it('round-trips a string id', () => {
    setActiveChatId('foo-123')
    expect(getActiveChatId()).toBe('foo-123')
  })

  it('clears via clearActiveChatId()', () => {
    setActiveChatId('foo')
    clearActiveChatId()
    expect(getActiveChatId()).toBeNull()
  })

  it('null/undefined clears the id', () => {
    setActiveChatId('foo')
    setActiveChatId(null)
    expect(getActiveChatId()).toBeNull()
    setActiveChatId('foo')
    setActiveChatId(undefined)
    expect(getActiveChatId()).toBeNull()
  })

  it('coerces non-string-like inputs to string', () => {
    setActiveChatId(42 as unknown as string)
    expect(getActiveChatId()).toBe('42')
  })
})

describe('agent-context › chatWorkspaceSlug', () => {
  // Per user feedback: workspace folders used to be raw UUIDs and the
  // user couldn't tell which chat owned which folder. Slug must be
  // recognisable in Explorer.

  it('uses kebab-case title with id suffix', () => {
    expect(chatWorkspaceSlug('8f7c2a1b-1234', 'Build me a random website')).toBe(
      'build-me-a-random-website-8f7c2a'
    )
  })

  it('falls back to id-only when title is empty', () => {
    expect(chatWorkspaceSlug('8f7c2a1b-1234', '')).toBe('8f7c2a')
    expect(chatWorkspaceSlug('8f7c2a1b-1234', null)).toBe('8f7c2a')
    expect(chatWorkspaceSlug('8f7c2a1b-1234', undefined)).toBe('8f7c2a')
  })

  it('falls back to id-only when title has no usable chars', () => {
    expect(chatWorkspaceSlug('abcdef-1234', '###***!!!')).toBe('abcdef')
  })

  it('returns "noid" suffix when id is empty', () => {
    expect(chatWorkspaceSlug('', 'Hello world')).toBe('hello-world-noid')
  })

  it('caps long titles at 40 chars', () => {
    const longTitle = 'a'.repeat(80)
    const slug = chatWorkspaceSlug('abcdef-1234', longTitle)
    // 40 chars of body + "-" + 6-char id
    expect(slug.length).toBeLessThanOrEqual(40 + 1 + 6)
    expect(slug.endsWith('-abcdef')).toBe(true)
  })

  it('strips non-alphanumeric runs and merges to single hyphen', () => {
    expect(chatWorkspaceSlug('xx-yy', 'Foo: Bar / Baz!! Qux')).toBe(
      'foo-bar-baz-qux-xxyy'
    )
  })

  it('lowercases mixed-case titles', () => {
    expect(chatWorkspaceSlug('aabbcc', 'My COOL Project')).toBe(
      'my-cool-project-aabbcc'
    )
  })

  it('handles unicode by stripping it (ascii-only slug)', () => {
    expect(chatWorkspaceSlug('xy12ab', 'Café résumé 漢字')).toBe('caf-r-sum-xy12ab')
  })

  it('trims leading/trailing hyphens from the slug body', () => {
    expect(chatWorkspaceSlug('xyz123', '!!!hello!!!')).toBe('hello-xyz123')
  })

  it('id suffix is always exactly 6 chars or "noid"', () => {
    // Long id is truncated, dashes stripped before slicing
    expect(chatWorkspaceSlug('aaaa-bbbb-cccc-dddd-eeee', 'x')).toBe('x-aaaabb')
    // Empty id → "noid"
    expect(chatWorkspaceSlug('', 'x')).toBe('x-noid')
  })
})
