/**
 * Nebenbefund 3 of the R9 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r9-nachmessung.md): the LU CLOUD group in the chat
 * model picker showed a different set of five on every look. Five measurements,
 * five different groups. The tester's words: whoever wants to find one
 * particular cloud model again is in for a long hunt.
 *
 * Checked whether that is a deliberate rotation. It is not. The app has no
 * rotation, no sampling and no shuffle anywhere on that path: the strip took
 * the first five models exactly as `/v1/models` handed them over, and that
 * payload has no rank field, no "featured" flag and no promised order, so which
 * five arrived was decided by the order of the last answer. The strip also
 * never said the list was longer than five.
 *
 * The two model sets below are the two the re-measure wrote down, in the order
 * it wrote them down.
 *
 * Run: npx vitest run src/lib/__tests__/cloud-teaser-stable.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { cloudTeaserModels, CLOUD_TEASER_LIMIT } from '../cloud-teaser-models'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const modelSelector = readFileSync(resolve(repo, 'src/components/models/ModelSelector.tsx'), 'utf8')

const m = (displayName: string) => ({ name: `lu-cloud::${displayName}`, displayName })

/** The ten models the two measurements between them showed. */
const CATALOGUE = [
  m('DeepSeek V4 Flash 0731'), m('Qwen3 VL 30B'), m('DeepSeek R1'),
  m('Qwen 3.5 397B A17B'), m('Kimi K3'), m('gpt-oss 120B'), m('GLM 5'),
  m('Hermes 3 405B'), m('Qwen 3.6 27B'), m('Qwen 3.6 35B A3B'),
]

/** The same ten as the second measurement happened to receive them. */
const REORDERED = [
  m('gpt-oss 120B'), m('GLM 5'), m('Hermes 3 405B'), m('Qwen 3.6 27B'),
  m('Qwen 3.6 35B A3B'), m('DeepSeek V4 Flash 0731'), m('Qwen3 VL 30B'),
  m('DeepSeek R1'), m('Qwen 3.5 397B A17B'), m('Kimi K3'),
]

const labels = (list: { displayName?: string }[]) => list.map((x) => x.displayName)

describe('THE FIX: the same five stand there every time', () => {
  it('two payload orders of one catalogue give one strip', () => {
    expect(labels(cloudTeaserModels(CATALOGUE).shown))
      .toEqual(labels(cloudTeaserModels(REORDERED).shown))
  })

  it('and the order inside the strip is the same too, not just the set', () => {
    expect(labels(cloudTeaserModels(REORDERED).shown)).toEqual([
      'DeepSeek R1', 'DeepSeek V4 Flash 0731', 'GLM 5', 'gpt-oss 120B', 'Hermes 3 405B',
    ])
  })

  it('a reversed payload changes nothing either', () => {
    expect(labels(cloudTeaserModels([...CATALOGUE].reverse()).shown))
      .toEqual(labels(cloudTeaserModels(CATALOGUE).shown))
  })

  it('the models that did not fit are counted, not silently dropped', () => {
    expect(cloudTeaserModels(CATALOGUE).more).toBe(CATALOGUE.length - CLOUD_TEASER_LIMIT)
  })

  it('case does not decide the order, so gpt-oss lands with the g names', () => {
    // A naive sort would put every lowercase name behind every capital one.
    expect(labels(cloudTeaserModels(CATALOGUE).shown)).toContain('gpt-oss 120B')
  })
})

describe('NEGATIVE CONTROL: what must not change', () => {
  it('the strip still shows at most five', () => {
    expect(cloudTeaserModels(CATALOGUE).shown).toHaveLength(CLOUD_TEASER_LIMIT)
  })

  it('a short catalogue shows everything and counts no rest', () => {
    const short = CATALOGUE.slice(0, 3)
    expect(cloudTeaserModels(short).shown).toHaveLength(3)
    expect(cloudTeaserModels(short).more).toBe(0)
  })

  it('an empty catalogue stays empty, the logged-out row is the picker`s job', () => {
    expect(cloudTeaserModels([]).shown).toEqual([])
    expect(cloudTeaserModels([]).more).toBe(0)
  })

  it('the caller`s array is not reordered under it', () => {
    const given = [...CATALOGUE]
    cloudTeaserModels(given)
    expect(labels(given)).toEqual(labels(CATALOGUE))
  })
})

describe('the wiring, so the rule reaches the screen', () => {
  it('the picker sorts through the rule instead of slicing the raw list', () => {
    expect(modelSelector).toMatch(/const \{ shown: cloudChat, more: cloudMore \} = cloudTeaserModels\(/)
    expect(modelSelector).not.toMatch(/m\.type === 'text'\)\.slice\(0, 5\)/)
  })

  it('it sorts by the label the user reads, not the raw id', () => {
    expect(modelSelector).toMatch(
      /cloudTeaserModels\([\s\S]{0,200}displayName\) \|\| displayModelName\(m\.name\)/,
    )
  })

  it('and the rest is offered instead of hidden', () => {
    expect(modelSelector).toMatch(/\{cloudMore\} more cloud \{cloudMore === 1 \? 'model' : 'models'\}, see them all/)
  })
})
