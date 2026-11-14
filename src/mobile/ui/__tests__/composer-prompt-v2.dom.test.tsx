// @vitest-environment jsdom
/**
 * Prompt v2 (14.11.2026, David: "perfekt go"). Under the field there is ONE row: the settings button with a grey
 * summary, Attach and Send (or the Create button with its price). Model, mode and tools are in the sheet behind
 * the settings button, nothing of it stands around the field.
 *
 * Run: npx vitest run src/mobile/ui/__tests__/composer-prompt-v2.dom.test.tsx
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Composer, tuneSummary } from '../Composer'

afterEach(cleanup)

const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('tuneSummary', () => {
  it('joins the parts that are there with a middle dot', () => {
    expect(tuneSummary(['Gemma 3 4B', 'Agent', null, '', false, '2 documents'])).toBe('Gemma 3 4B · Agent · 2 documents')
    expect(tuneSummary([undefined, null])).toBe('')
  })
})

describe('the row under the field', () => {
  it('holds the settings button, Attach and Send, in this order, and nothing else', () => {
    const onTune = vi.fn()
    const onAttach = vi.fn()
    render(
      <Composer
        value="hi"
        onChange={() => {}}
        onSend={() => {}}
        idPrefix="m-x"
        tune={{ summary: <><b>Gemma 3 4B</b> · Agent</>, label: 'Chat settings: Gemma 3 4B · Agent', onPress: onTune, changed: true, place: 'cloud', testid: 'm-x-options' }}
        attach={{ label: 'Attach', onPress: onAttach, testid: 'm-x-attach' }}
      />,
    )
    const row = screen.getByTestId('m-x-options').parentElement!
    expect([...row.children].map((c) => c.getAttribute('data-testid'))).toEqual(['m-x-options', 'm-x-attach', 'm-x-send'])
    const tune = screen.getByTestId('m-x-options')
    expect(tune.getAttribute('aria-label')).toBe('Chat settings: Gemma 3 4B · Agent')
    expect(tune.textContent).toContain('Gemma 3 4B · Agent')
    expect(tune.getAttribute('data-m-place')).toBe('cloud')
    expect(screen.getByTestId('m-x-options-changed')).toBeTruthy()
    fireEvent.click(tune)
    fireEvent.click(screen.getByTestId('m-x-attach'))
    expect(onTune).toHaveBeenCalledTimes(1)
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('no dot while nothing differs', () => {
    render(<Composer value="" onChange={() => {}} onSend={() => {}} idPrefix="m-x" tune={{ summary: 'Gemma', label: 'Chat settings: Gemma', onPress: () => {}, testid: 'm-x-options' }} />)
    expect(screen.queryByTestId('m-x-options-changed')).toBeNull()
  })

  it('an action takes the place of Send while nothing runs, Stop comes back while it runs', () => {
    const { rerender } = render(<Composer value="a lighthouse" onChange={() => {}} onSend={() => {}} idPrefix="m-x" action={<button data-testid="m-x-go">Create 500</button>} />)
    expect(screen.getByTestId('m-x-go')).toBeTruthy()
    expect(screen.queryByTestId('m-x-send')).toBeNull()
    rerender(<Composer value="a lighthouse" onChange={() => {}} onSend={() => {}} idPrefix="m-x" running onStop={() => {}} action={<button data-testid="m-x-go">Create 500</button>} />)
    expect(screen.queryByTestId('m-x-go')).toBeNull()
    expect(screen.getByTestId('m-x-stop')).toBeTruthy()
  })
})

describe('the sources keep to it', () => {
  it('no page passes a model chip or icon buttons to the composer row any more', () => {
    for (const rel of ['screens/chat/ChatPage.tsx', 'screens/remote/RemoteChatPage.tsx', 'screens/remote/SharedChatPage.tsx', 'screens/agent/ComparePage.tsx']) {
      const src = read(rel)
      expect(src, rel).not.toMatch(/\bleading=\{/)
      expect(src, rel).not.toMatch(/\bmodel=\{\s*</)
    }
  })

  it('Create has no tool row above the field and no model chip beside it; both are in the run settings', () => {
    const create = read('screens/create/CreatePage.tsx')
    expect(create).not.toMatch(/m-k-toolrow|<ModelChip/)
    const computer = read('screens/create/ComputerSurface.tsx')
    expect(computer).not.toMatch(/m-k-toolrow|<ModelChip/)
    const run = read('screens/create/RunSettingsSheet.tsx')
    expect(run).toMatch(/testid="m-create-tools-all"/)
    expect(run).toMatch(/testid="m-create-model"/)
    expect(read('screens/create/ComputerSettingsSheet.tsx')).toMatch(/m-create-computer-tool-\$\{t\.id\}/)
  })

  it('the chat options start with the model, the remote options too', () => {
    expect(read('screens/agent/ChatOptionsSheet.tsx')).toMatch(/testid="m-options-model"/)
    expect(read('screens/remote/RemoteOptionsSheet.tsx')).toMatch(/testid="m-remote-options-model"/)
  })

  it('the field is 16 px at least and three lines high, so iOS does not zoom and the field leads', () => {
    const css = read('styles/components.css')
    const rule = css.slice(css.indexOf('.m-composer textarea {'), css.indexOf('}', css.indexOf('.m-composer textarea {')))
    expect(rule).toMatch(/font-size: max\(var\(--m-text-body\), 16px\)/)
    expect(rule).toMatch(/\* 1\.45 \* 3 \+ 16px/)
  })
})
