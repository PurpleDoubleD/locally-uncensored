// @vitest-environment jsdom
/**
 * B43 (3.0.9): a prompt assistant in Create. A few keywords and a template of
 * the picked model's family give a prompt at once, offline; Refine hands that
 * draft to the existing "Improve my prompt" call, aimed at the same family;
 * the prompt only changes when the user presses Use.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/prompt-assistant-b43.test.tsx
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const improve = vi.hoisted(() => ({ calls: [] as Array<{ prompt: string; target: unknown }>, answer: { status: 'improved', prompt: 'REFINED' } as unknown }))
vi.mock('../../../../lib/render/improve-prompt-run', () => ({
  improvePrompt: async (prompt: string, target: unknown) => {
    improve.calls.push({ prompt, target })
    return improve.answer
  },
  useImproveAvailability: () => ({ available: true, hint: 'Your chat model rewrites your prompt.' }),
}))

import {
  TEMPLATES, buildFromTemplate, familyFor, refineTarget, splitKeywords, type PromptFamily,
} from '../../../../lib/render/prompt-assistant'
import { PromptAssistant } from '../PromptAssistant'
import { useCreateStore } from '../../../../stores/createStore'

describe('B43: the family a prompt is written for', () => {
  it('SD checkpoints read tags, Pony gets its score tags, newer models read prose', () => {
    expect(familyFor('image', 'sd15')).toBe('tags-sd15')
    expect(familyFor('image', 'sdxl', 'juggernautXL_v9.safetensors')).toBe('tags-sdxl')
    expect(familyFor('image', 'sdxl', 'ponyDiffusionV6XL.safetensors')).toBe('tags-pony')
    for (const t of ['flux', 'flux2', 'qwenimage', 'zimage', 'hidream', 'sd3', 'chroma', 'unknown']) {
      expect(familyFor('image', t)).toBe('prose')
    }
    expect(familyFor('video', 'wan')).toBe('video')
    expect(familyFor('music', 'ace')).toBe('music')
  })

  it('every family has a library of at least three templates, each with a slot for the keywords', () => {
    for (const fam of Object.keys(TEMPLATES) as PromptFamily[]) {
      expect(TEMPLATES[fam].length).toBeGreaterThanOrEqual(3)
      for (const t of TEMPLATES[fam]) expect(t.pattern).toContain('{k}')
    }
  })
})

describe('B43: the draft, offline', () => {
  it('keeps every keyword, in order, once', () => {
    expect(splitKeywords(' red fox, snowy forest\n dusk , Red Fox ;')).toEqual(['red fox', 'snowy forest', 'dusk'])
    const out = buildFromTemplate(TEMPLATES.prose[0], 'red fox, snowy forest, dusk')
    expect(out).toMatch(/^A photograph of red fox, snowy forest, dusk\./)
  })

  it('Pony puts the score tags first, then the keywords', () => {
    const out = buildFromTemplate(TEMPLATES['tags-pony'][0], 'knight, castle')
    expect(out.startsWith('score_9, score_8_up, score_7_up')).toBe(true)
    expect(out).toContain('knight, castle')
  })

  it('no keywords, no prompt: a template alone is not a prompt', () => {
    expect(buildFromTemplate(TEMPLATES.video[0], ' , ')).toBe('')
  })

  it('Refine is the Improve call with tags for the tag families', () => {
    expect(refineTarget('image', 'tags-sdxl', 'x.safetensors')).toEqual({ kind: 'image', modelLabel: 'x.safetensors', tags: true })
    expect(refineTarget('image', 'prose', '')).toEqual({ kind: 'image', modelLabel: undefined, tags: false })
  })
})

describe('B43: the assistant in the composer', () => {
  beforeEach(() => {
    improve.calls = []
    improve.answer = { status: 'improved', prompt: 'REFINED' }
    useCreateStore.setState({
      imageModel: 'ponyDiffusionV6XL.safetensors',
      imageModelList: [{ name: 'ponyDiffusionV6XL.safetensors', type: 'sdxl' }] as never,
    })
  })
  afterEach(cleanup)

  function openAssistant(onUse = vi.fn()) {
    render(<PromptAssistant onUse={onUse} />)
    fireEvent.click(screen.getByTitle('Prompt assistant'))
    return onUse
  }

  it('the picked model decides the library, and Use hands the draft over', () => {
    const onUse = openAssistant()
    expect(screen.getByTestId('prompt-assistant').dataset.family).toBe('tags-pony')
    fireEvent.change(screen.getByTestId('prompt-assistant-keywords'), { target: { value: 'knight, castle' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Realistic' }))
    const draft = screen.getByTestId('prompt-assistant-result').textContent
    expect(draft).toBe(buildFromTemplate(TEMPLATES['tags-pony'][1], 'knight, castle'))
    expect(onUse).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('prompt-assistant-use'))
    expect(onUse).toHaveBeenCalledWith(draft)
  })

  it('Refine sends the draft through Improve, and Use takes the refined text', async () => {
    const onUse = openAssistant()
    fireEvent.change(screen.getByTestId('prompt-assistant-keywords'), { target: { value: 'knight' } })
    fireEvent.click(screen.getByTestId('prompt-assistant-refine'))
    await waitFor(() => expect(screen.getByTestId('prompt-assistant-result').textContent).toBe('REFINED'))
    expect(improve.calls).toHaveLength(1)
    expect(improve.calls[0].prompt).toContain('knight')
    expect(improve.calls[0].target).toEqual({ kind: 'image', modelLabel: 'ponyDiffusionV6XL.safetensors', tags: true })
    fireEvent.click(screen.getByTestId('prompt-assistant-use'))
    expect(onUse).toHaveBeenCalledWith('REFINED')
  })

  it('a failed refine keeps the draft and says so', async () => {
    improve.answer = { status: 'failed' }
    openAssistant()
    fireEvent.change(screen.getByTestId('prompt-assistant-keywords'), { target: { value: 'knight' } })
    const draft = screen.getByTestId('prompt-assistant-result').textContent
    fireEvent.click(screen.getByTestId('prompt-assistant-refine'))
    await screen.findByText(/did not answer/)
    expect(screen.getByTestId('prompt-assistant-result').textContent).toBe(draft)
  })
})

describe('B43: where it sits', () => {
  it('next to the prompt history in the composer, writing into the prompt', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../Composer.tsx'), 'utf8')
    expect(src).toMatch(/\{needPrompt && <PromptAssistant onUse=\{setPrompt\} \/>\}\n\s*\{needPrompt && <PromptHistory/)
  })
})
