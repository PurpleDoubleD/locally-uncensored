/**
 * Tags and hiding in the gallery (D27, 3.1.0): the pure rules.
 *
 * Run: npx vitest run src/lib/__tests__/gallery-tags.test.ts
 */
import { describe, expect, it } from 'vitest'
import { TAG_MAX, TAGS_PER_ITEM, cleanTag, hasTag, hiddenCount, itemsInView, sanitizeTags, tagCounts, withTag, withoutTag } from '../gallery-tags'

describe('tags', () => {
  it('cleanTag drops a leading #, folds spaces, cuts long ones, refuses empty ones', () => {
    expect(cleanTag('  #My   tag ')).toBe('My tag')
    expect(cleanTag('##')).toBeNull()
    expect(cleanTag('x'.repeat(TAG_MAX + 9))).toHaveLength(TAG_MAX)
  })

  it('withTag ignores case for doubles and stops at the limit', () => {
    let tags: string[] | undefined
    tags = withTag(tags, 'Cat')
    expect(withTag(tags, 'cat')).toBe(tags)
    for (let i = 0; i < 20; i++) tags = withTag(tags, `t${i}`)
    expect(tags).toHaveLength(TAGS_PER_ITEM)
  })

  it('withoutTag gives undefined once the last tag is gone', () => {
    expect(withoutTag(['a'], 'A')).toBeUndefined()
    const same = ['a']
    expect(withoutTag(same, 'b')).toBe(same)
  })

  it('sanitizeTags keeps clean strings only', () => {
    expect(sanitizeTags(['a', 3, null, 'A', ''])).toEqual(['a'])
    expect(sanitizeTags('a')).toBeUndefined()
  })

  it('tagCounts sorts by use, then by name', () => {
    expect(tagCounts([{ tags: ['b', 'a'] }, { tags: ['B'] }, {}])).toEqual([{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }])
  })
})

describe('the view', () => {
  const items = [
    { id: '1', tags: ['x'] },
    { id: '2', hidden: true, tags: ['x'] },
    { id: '3', folderId: 'f' },
    { id: '4', folderId: 'f', tags: ['X'] },
  ]
  const view = (v: Partial<{ folderId: string | null; tag: string | null; hidden: boolean }>) =>
    itemsInView(items, { folderId: null, tag: null, hidden: false, ...v }).map((g) => g.id)

  it('hidden entries only in the Hidden view', () => {
    expect(view({})).toEqual(['1', '3', '4'])
    expect(view({ hidden: true })).toEqual(['2'])
    expect(hiddenCount(items)).toBe(1)
  })

  it('folder and tag filter together', () => {
    expect(view({ tag: 'x' })).toEqual(['1', '4'])
    expect(view({ folderId: 'f', tag: 'x' })).toEqual(['4'])
    expect(hasTag(items[3], 'x')).toBe(true)
  })
})
