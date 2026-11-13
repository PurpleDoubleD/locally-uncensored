/**
 * @vitest-environment jsdom
 *
 * U8: `@` file mentions in the composer that Chat, Agent and Code share.
 * Typing `@` opens the file list of the working folder, the arrow keys move,
 * Enter or Tab picks, Esc closes. A pick puts `@path` into the text and a chip
 * into the attachment row; the send hands the file on as an ordinary
 * attachment, and a secret file is refused with a note above the thread.
 *
 * Run: npx vitest run src/components/chat/__tests__/composer-file-mentions.test.tsx
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

const tree: Record<string, string> = {
  'src/math.ts': 'export const add = (a: number, b: number) => a + b\n',
  'src/main.ts': 'import { add } from "./math"\n',
  'README.md': '# demo\n',
  '.env': 'API_KEY=secret\n',
  'node_modules/left-pad/index.js': 'module.exports = 1\n',
}

vi.mock('../../../api/backend', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../api/backend')>()
  return {
    ...real,
    backendCall: vi.fn(async (command: string, args: Record<string, unknown>) => {
      const path = String(args.path)
      const rel = path === '.' ? '' : path.replace(/^\/proj\/?/, '')
      if (command === 'fs_list') {
        const prefix = rel ? `${rel}/` : ''
        const seen = new Map<string, boolean>()
        for (const key of Object.keys(tree)) {
          if (!key.startsWith(prefix)) continue
          const [first, ...more] = key.slice(prefix.length).split('/')
          seen.set(first, more.length > 0)
        }
        return { entries: [...seen].map(([name, isDir]) => ({ name, path: `/proj/${prefix}${name}`, isDir, size: tree[`${prefix}${name}`]?.length ?? 0, modified: 0 })) }
      }
      if (command === 'fs_read') return { encoding: 'utf8', content: tree[rel] }
      throw new Error(`unexpected ${command}`)
    }),
  }
})

import { ChatInput } from '../ChatInput'
import { useChatNoticeStore } from '../../../stores/chatNoticeStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { __clearMentionCache } from '../../../lib/file-mentions'
import type { ChatFileInput } from '../../../lib/chat-files'

beforeEach(() => {
  __clearMentionCache()
  useChatNoticeStore.getState().clear()
  useSettingsStore.getState().updateSettings({ emojiAutoReplace: false })
})
afterEach(() => cleanup())

function composer(onSend: (text: string, files?: ChatFileInput[]) => void = () => {}, root: { workingDirectory: string } | null = { workingDirectory: '/proj' }) {
  const view = render(
    <ChatInput
      onSend={(text, _images, files) => onSend(text, files)}
      onStop={() => {}}
      isGenerating={false}
      modelReady={() => true}
      filesReachTools
      mentionRoot={root}
    />,
  )
  const field = view.container.querySelector('textarea[data-lu-composer]') as HTMLTextAreaElement
  const type = (value: string) => {
    field.setSelectionRange?.(field.value.length, field.value.length)
    fireEvent.change(field, { target: { value, selectionStart: value.length } })
  }
  return { view, field, type }
}

const rows = (view: ReturnType<typeof render>) => Array.from(view.container.querySelectorAll('[data-testid="mention-row"]'))

describe('@ file mentions in the composer', () => {
  it('opens the list on @, filters it, and leaves node_modules out', async () => {
    const { view, type } = composer()
    type('@')
    expect(view.getByTestId('mention-menu')).toBeTruthy()
    await waitFor(() => expect(rows(view).length).toBeGreaterThan(0))
    expect(rows(view).some((r) => r.textContent?.includes('node_modules'))).toBe(false)
    type('@math')
    await waitFor(() => expect(rows(view)[0]?.textContent).toContain('math.ts'))
    expect(rows(view)[0].getAttribute('aria-selected')).toBe('true')
  })

  it('moves with the arrow keys, picks with Enter, and the send carries the file', async () => {
    const sent: { text: string; files?: ChatFileInput[] }[] = []
    const { view, field, type } = composer((text, files) => sent.push({ text, files }))
    type('look at @ma')
    await waitFor(() => expect(rows(view).length).toBe(2))
    const names = rows(view).map((r) => r.textContent ?? '')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(rows(view)[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(rows(view)[1].getAttribute('aria-selected')).toBe('true')
    const picked = names[1].includes('math.ts') ? 'src/math.ts' : 'src/main.ts'
    // Enter picks and does not send.
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(sent).toEqual([])
    expect(field.value).toBe(`look at @${picked} `)
    expect(view.queryByTestId('mention-menu')).toBeNull()
    await waitFor(() => expect(view.container.querySelector('[data-mention="true"]')?.textContent).toContain(`@${picked}`))

    type(`look at @${picked} what does it do?`)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toBe(`look at @${picked} what does it do?`)
    const file = sent[0].files![0]
    expect(file.attachment.workspacePath).toBe(picked)
    expect(file.attachment.summary).toContain(tree[picked].trim())
  })

  it('picks with Tab and closes with Esc, which stays closed for that word', async () => {
    const { view, field, type } = composer()
    type('@READ')
    await waitFor(() => expect(rows(view).length).toBe(1))
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(view.queryByTestId('mention-menu')).toBeNull()
    type('@READM')
    expect(view.queryByTestId('mention-menu')).toBeNull()
    type('@READM @READ')
    await waitFor(() => expect(rows(view).length).toBe(1))
    fireEvent.keyDown(field, { key: 'Tab' })
    expect(field.value).toBe('@READM @README.md ')
  })

  it('refuses a secret file with a note and adds no chip', async () => {
    const { view, field, type } = composer()
    type('@.env')
    await waitFor(() => expect(rows(view)[0]?.textContent).toContain('private'))
    fireEvent.keyDown(field, { key: 'Enter' })
    const notice = useChatNoticeStore.getState().notices.find((n) => n.id === 'file-mention')
    expect(notice?.text).toBe('.env stays private: it holds environment secrets (.env). LU never sends secret files to a model.')
    expect(view.container.querySelector('[data-mention="true"]')).toBeNull()
  })

  it('takes the chip away when its token is deleted, and the token when the chip is removed', async () => {
    const { view, field, type } = composer()
    type('@README')
    await waitFor(() => expect(rows(view).length).toBe(1))
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(view.container.querySelector('[data-mention="true"]')).not.toBeNull())
    type('')
    expect(view.container.querySelector('[data-mention="true"]')).toBeNull()

    type('fix @README')
    await waitFor(() => expect(rows(view).length).toBe(1))
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(view.container.querySelector('[data-mention="true"]')).not.toBeNull())
    await act(async () => { fireEvent.click(view.getByLabelText('Remove README.md')) })
    expect(field.value).toBe('fix ')
  })

  it('says so when no working folder is known, and stays off where mentions are off', () => {
    const { view, type } = composer(() => {}, null)
    type('@')
    expect(view.getByTestId('mention-menu').textContent).toContain('No working folder yet')
    cleanup()
    const off = render(<ChatInput onSend={() => {}} onStop={() => {}} isGenerating={false} modelReady={() => true} />)
    const field = off.container.querySelector('textarea[data-lu-composer]') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '@' } })
    expect(off.queryByTestId('mention-menu')).toBeNull()
  })
})
