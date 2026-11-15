/**
 * @vitest-environment jsdom
 *
 * The two panels of the Voice surface as the user sees them: every state of
 * the setup, and in a session the approval, the error help and the one line
 * for a model without tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { VoiceLoopInstallStatus, VoiceLoopRequirements } from '../../../api/voice-loop'
import { VOICE_IDLE } from '../../../lib/voice/session-state'
import type { VoiceEvent } from '../../../lib/voice/session-state'

const session = vi.hoisted(() => ({
  startVoiceSession: vi.fn(async () => {}),
  stopVoiceSession: vi.fn(),
  answerVoiceApproval: vi.fn(),
  setVoiceMuted: vi.fn(),
}))
vi.mock('../../../api/voice-session', () => session)

import { VoiceSetupPanel } from '../VoiceSetupPanel'
import { VoiceSessionPanel } from '../VoiceSessionPanel'
import { useVoiceSessionStore } from '../../../stores/voiceSessionStore'
import { useModelStore } from '../../../stores/modelStore'

function requirements(patch: Partial<VoiceLoopRequirements> = {}): VoiceLoopRequirements {
  return {
    supported: true,
    unsupportedReason: null,
    installed: false,
    installDir: '/data/voice',
    python: { version: '3.12.15', installed: false, downloadBytes: 25_013_243 },
    packages: { installed: false, downloadBytesEstimate: 335_000_000, diskBytesEstimate: 1_100_000_000, versions: { 'pipecat-ai': '1.12.0' } },
    models: [
      { id: 'stt', name: 'Whisper base.en', role: 'stt', license: 'MIT', attribution: null, bytes: 147_769_510, installed: false },
      { id: 'tts', name: 'Pocket TTS', role: 'tts', license: 'CC-BY-4.0', attribution: 'Pocket TTS by Kyutai, licensed under CC BY 4.0.', bytes: 219_088_535, installed: false },
    ],
    modelsBytes: 366_858_045,
    voice: 'alba',
    voices: [
      { name: 'alba', license: 'CC-BY-4.0', attribution: 'Voice "alba" from recordings by Alba MacKenna, licensed under CC BY 4.0.', bytes: 6_194_424, installed: false },
      { name: 'anna', license: 'CC-BY-4.0', attribution: 'Voice "anna" from the CSTR VCTK Corpus, licensed under CC BY 4.0.', bytes: 7_816_440, installed: false },
      { name: 'marius', license: 'CC0-1.0', attribution: 'Voice "marius" from the Unmute Voice Donation Project, released as CC0.', bytes: 6_194_424, installed: false },
    ],
    downloadBytes: 726_871_288,
    diskBytesNeeded: 2_300_000_000,
    diskBytesFree: 50_000_000_000,
    enoughSpace: true,
    ...patch,
  }
}

function status(patch: Partial<VoiceLoopInstallStatus> = {}): VoiceLoopInstallStatus {
  return {
    status: 'running', phase: 'packages', message: 'Installing the speech packages.', currentFile: null,
    bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0, logs: [], detail: ['Downloading torch-2.14.1'], error: null, ...patch,
  }
}

const handlers = () => ({ onInstall: vi.fn(), onCancel: vi.fn(), onRetryLoad: vi.fn() })

afterEach(() => cleanup())

describe('VoiceSetupPanel', () => {
  it('needed: the voice is chosen before anything is downloaded, alba first', () => {
    const onChooseVoice = vi.fn()
    const view = render(createElement(VoiceSetupPanel, {
      mode: 'needed', requirements: requirements(), status: null, loadError: null, actionError: null, ...handlers(), onChooseVoice,
    }))
    const picker = view.getByLabelText('Voice') as HTMLSelectElement
    expect(picker.value).toBe('alba')
    expect([...picker.options].map((option) => option.textContent)).toEqual(['Alba', 'Anna', 'Marius'])
    fireEvent.change(picker, { target: { value: 'marius' } })
    expect(onChooseVoice).toHaveBeenCalledWith('marius')
    expect(view.container.textContent).toContain('You can change it later in the voice settings.')
  })

  it('the choice waits while it is written and while the setup runs', () => {
    const waiting = render(createElement(VoiceSetupPanel, {
      mode: 'needed', requirements: requirements(), status: null, loadError: null, actionError: null, ...handlers(), onChooseVoice: vi.fn(), choosingVoice: true,
    }))
    expect((waiting.getByLabelText('Voice') as HTMLSelectElement).disabled).toBe(true)
    expect((waiting.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const running = render(createElement(VoiceSetupPanel, {
      mode: 'installing', requirements: requirements(), status: status(), loadError: null, actionError: null, ...handlers(), onChooseVoice: vi.fn(),
    }))
    expect((running.getByLabelText('Voice') as HTMLSelectElement).disabled).toBe(true)
  })

  it('one voice is no choice: the list stays away', () => {
    const view = render(createElement(VoiceSetupPanel, {
      mode: 'needed', requirements: requirements({ voices: requirements().voices.slice(0, 1) }), status: null, loadError: null, actionError: null, ...handlers(), onChooseVoice: vi.fn(),
    }))
    expect(view.queryByLabelText('Voice')).toBeNull()
  })

  it('needed: the totals, the parts and credits one click away, and Install starts it', () => {
    const on = handlers()
    const view = render(createElement(VoiceSetupPanel, { mode: 'needed', requirements: requirements(), status: null, loadError: null, actionError: null, ...on }))
    expect(view.container.textContent).toContain('Free space')
    expect(view.container.textContent).not.toContain('Whisper base.en')
    fireEvent.click(view.getByRole('button', { name: 'What is downloaded' }))
    const text = view.container.textContent ?? ''
    expect(text).toContain('Whisper base.en')
    expect(text).toContain('Stored in /data/voice')
    expect(text).toContain('Pocket TTS by Kyutai, licensed under CC BY 4.0.')
    fireEvent.click(view.getByRole('button', { name: 'Install' }))
    expect(on.onInstall).toHaveBeenCalledTimes(1)
  })

  it('installing: shows the step, the line pip printed, and Cancel instead of Install', () => {
    const on = handlers()
    const view = render(createElement(VoiceSetupPanel, { mode: 'installing', requirements: requirements(), status: status(), loadError: null, actionError: null, ...on }))
    expect(view.getByTestId('voice-setup-line').textContent).toContain('Downloading torch-2.14.1')
    expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
    expect(view.queryByRole('button', { name: 'Install' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(on.onCancel).toHaveBeenCalledTimes(1)
  })

  it('cancelled and failed: say what happened and offer the matching button', () => {
    const on = handlers()
    const cancelled = render(createElement(VoiceSetupPanel, { mode: 'cancelled', requirements: requirements(), status: status({ status: 'cancelled' }), loadError: null, actionError: null, ...on }))
    expect(cancelled.container.textContent).toContain('What was already downloaded is kept')
    expect(cancelled.getByRole('button', { name: 'Continue setup' })).toBeTruthy()
    cleanup()
    const failed = render(createElement(VoiceSetupPanel, { mode: 'failed', requirements: requirements(), status: status({ status: 'error', error: 'The connection was reset.' }), loadError: null, actionError: null, ...on }))
    expect(failed.getByRole('alert').textContent).toContain('The connection was reset.')
    fireEvent.click(failed.getByRole('button', { name: 'Try again' }))
    expect(on.onInstall).toHaveBeenCalledTimes(1)
  })

  it('too little space: says how much is needed and Install is off', () => {
    const view = render(createElement(VoiceSetupPanel, {
      mode: 'needed', requirements: requirements({ enoughSpace: false, diskBytesFree: 1_000_000 }), status: null, loadError: null, actionError: null, ...handlers(),
    }))
    expect(view.getByRole('alert').textContent).toContain('Not enough free space.')
    expect((view.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('unsupported: one calm sentence, no alert and no Install', () => {
    const view = render(createElement(VoiceSetupPanel, {
      mode: 'unsupported', requirements: requirements({ supported: false, unsupportedReason: 'Voice needs a Mac with Apple silicon.' }),
      status: null, loadError: null, actionError: null, ...handlers(),
    }))
    expect(view.getByRole('status').textContent).toBe('Voice needs a Mac with Apple silicon.')
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('unavailable: shows why and offers to read the setup again', () => {
    const on = handlers()
    const view = render(createElement(VoiceSetupPanel, { mode: 'unavailable', requirements: null, status: null, loadError: 'The app backend did not answer.', actionError: null, ...on }))
    expect(view.getByRole('alert').textContent).toContain('The app backend did not answer.')
    fireEvent.click(view.getByRole('button', { name: 'Try again' }))
    expect(on.onRetryLoad).toHaveBeenCalledTimes(1)
  })
})

describe('removing the voice engine', () => {
  it('has a state of its own: no Start, no Install, one line that says what happens', () => {
    const view = render(createElement(VoiceSetupPanel, { mode: 'removing', requirements: requirements({ installed: true }), status: null, loadError: null, actionError: null, ...handlers() }))
    expect(view.getByTestId('voice-removing').textContent).toContain('Removing the voice engine')
    expect(view.queryByRole('button')).toBeNull()
  })
})

describe('VoiceSessionPanel', () => {
  const send = (...events: VoiceEvent[]) => act(() => { for (const event of events) useVoiceSessionStore.getState().dispatch(event) })
  const live = (): VoiceEvent[] => [{ type: 'start', at: Date.now(), muted: false }, { type: 'brain', modelLabel: 'Qwen 9B', notice: null }, { type: 'ready' }]

  beforeEach(() => {
    useVoiceSessionStore.setState({ ...VOICE_IDLE })
    Object.values(session).forEach((mock) => mock.mockClear())
  })

  it('idle: the Start button starts the session straight from the click', () => {
    const view = render(createElement(VoiceSessionPanel))
    expect(view.getByTestId('voice-status').textContent).toBe('Ready')
    expect(view.getByTestId('voice-waves').getAttribute('data-mood')).toBe('idle')
    expect(view.queryByRole('button', { name: 'Stop voice' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Start voice' }))
    expect(session.startVoiceSession).toHaveBeenCalledTimes(1)
  })

  it('after a session the idle surface names the model picked in Chat now, not the model of the session before', () => {
    // Found on 08.10.2026: the surface still named the model of the last
    // session, and the session started from there ran on the one picked since.
    const before = useModelStore.getState().activeModel
    try {
      act(() => { useModelStore.setState({ activeModel: 'big-model:27b' }) })
      const view = render(createElement(VoiceSessionPanel))
      const sentence = () => view.container.textContent ?? ''
      expect(sentence()).toContain('Voice answers with big-model:27b, the model selected in Chat.')
      // A session on that model that ends before a word was said.
      send({ type: 'start', at: Date.now(), muted: false }, { type: 'brain', modelLabel: 'big-model:27b', notice: null }, { type: 'ready' }, { type: 'stopping' }, { type: 'stopped' })
      act(() => { useModelStore.setState({ activeModel: 'small-model:4b' }) })
      expect(sentence()).toContain('Voice answers with small-model:4b, the model selected in Chat.')
      expect(sentence()).not.toContain('big-model:27b')
      // And after a session that failed.
      send({ type: 'start', at: Date.now(), muted: false }, { type: 'brain', modelLabel: 'small-model:4b', notice: null }, { type: 'failed', error: { kind: 'model-error', message: 'The session stopped because of an error.' } })
      act(() => { useModelStore.setState({ activeModel: 'openai::other-model' }) })
      expect(sentence()).toContain('Voice answers with other-model, the model selected in Chat.')
    } finally {
      act(() => { useModelStore.setState({ activeModel: before }) })
    }
  })

  it('a second Enter on Start does not land on the mute button', () => {
    const view = render(createElement(VoiceSessionPanel))
    const start = view.getByRole('button', { name: 'Start voice' })
    start.focus()
    expect(document.activeElement).toBe(start)
    send(...live())
    const mute = view.getByRole('button', { name: 'Mute microphone' })
    expect(mute).not.toBe(start)
    expect(document.activeElement).not.toBe(mute)
    expect(document.activeElement).not.toBe(view.getByRole('button', { name: 'Stop voice' }))
  })

  it('live: shows both sides of the talk, the state, mute and stop', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(...live(), { type: 'user-text', text: 'What time is it?', final: true }, { type: 'bot-thinking' })
    expect(view.getByTestId('voice-status').textContent).toBe('Thinking')
    send({ type: 'bot-text', text: 'It is ten past four.' }, { type: 'bot-speaking' })
    expect(view.getByTestId('voice-status').textContent).toBe('Speaking')
    expect(view.getByTestId('voice-waves').getAttribute('data-mood')).toBe('speaking')
    const lines = [...view.container.querySelectorAll('[data-role]')].map((node) => `${node.getAttribute('data-role')}: ${node.textContent}`)
    expect(lines).toEqual(['user: What time is it?', 'assistant: It is ten past four.'])
    fireEvent.click(view.getByRole('button', { name: 'Mute microphone' }))
    expect(session.setVoiceMuted).toHaveBeenCalledWith(true)
    fireEvent.click(view.getByRole('button', { name: 'Stop voice' }))
    expect(session.stopVoiceSession).toHaveBeenCalledTimes(1)
  })

  it('a thought is the folded Thinking block of the chat with its duration, never a line of raw text', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(...live(), { type: 'user-text', text: 'Why is the sky blue?', final: true }, { type: 'thought-text', text: 'The user asks about Rayleigh scattering.' })
    const thought = view.container.querySelector('[data-role="thought"]')!
    // While it runs: the header of the chat, and a bounded peek.
    expect(within(thought as HTMLElement).getByRole('button', { name: 'Toggle thinking details' }).textContent).toBe('Thinking')
    send({ type: 'thought-end', secs: 2.6 }, { type: 'bot-text', text: 'Because air scatters blue light most.' })
    const header = within(thought as HTMLElement).getByRole('button', { name: 'Toggle thinking details' })
    expect(header.textContent).toBe('Thought for 3 s')
    // Folded: the thought itself is not on the surface until the user opens it.
    expect(thought.textContent).not.toContain('Rayleigh')
    expect(view.container.textContent).not.toContain('<think>')
    fireEvent.click(header)
    expect(thought.textContent).toContain('Rayleigh scattering')
    const roles = [...view.container.querySelectorAll('[data-role]')].map((node) => node.getAttribute('data-role'))
    expect(roles).toEqual(['user', 'thought', 'assistant'])
  })

  it('the transcript is there from the start, hidden while it is empty, so its scroll position is always watched', () => {
    const view = render(createElement(VoiceSessionPanel))
    const transcript = view.getByTestId('voice-transcript')
    expect(transcript.className).toContain('hidden')
    send(...live(), { type: 'user-text', text: 'Hello.', final: true })
    expect(view.getByTestId('voice-transcript')).toBe(transcript)
    expect(transcript.className).not.toContain('hidden')
  })

  it('approval: the strip of the chat, asking in plain words, answered once per click or key', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(...live(), { type: 'tool-waiting', id: 'call-1', name: 'file_write', args: { path: 'lists/shopping.txt', content: 'milk' } })
    expect(view.getByTestId('voice-status').textContent).toBe('Waiting for your approval')
    const strip = within(view.getByTestId('voice-approval'))
    // In words. The tool's own name is the tooltip and sits behind "Show arguments".
    const what = strip.getByTestId('approval-what')
    expect(what.textContent).toBe('Voice wants to change a file. Nothing happens until you answer.')
    expect(what.getAttribute('title')).toBe('file_write')
    expect(view.getByTestId('voice-approval').textContent).not.toContain('file_write')
    expect(view.getByTestId('voice-approval').querySelector('pre')).toBeNull()
    fireEvent.click(strip.getByTitle('Show arguments'))
    expect(view.getByTestId('voice-approval').querySelector('pre')?.textContent).toContain('file_write')
    expect(view.getByTestId('voice-approval').querySelector('pre')?.textContent).toContain('"path": "lists/shopping.txt"')
    expect(session.answerVoiceApproval).not.toHaveBeenCalled()
    fireEvent.click(strip.getByRole('button', { name: 'Approve' }))
    expect(session.answerVoiceApproval).toHaveBeenCalledWith(true)
    fireEvent.click(strip.getByRole('button', { name: 'Reject' }))
    expect(session.answerVoiceApproval).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(session.answerVoiceApproval).toHaveBeenLastCalledWith(false)
    expect(session.answerVoiceApproval).toHaveBeenCalledTimes(3)
  })

  it('approval: the waiting call is the open tool block of the chat, with what it would write and its own two buttons', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(...live(), { type: 'tool-waiting', id: 'call-1', name: 'file_write', args: { path: 'lists/shopping.txt', content: 'milk' } })
    const block = view.getByRole('group', { name: 'Tools' }).querySelector('[data-tool="file_write"]') as HTMLElement
    expect(block.getAttribute('data-status')).toBe('pending_approval')
    expect(block.querySelector('pre')?.textContent).toContain('"content": "milk"')
    fireEvent.click(within(block).getByRole('button', { name: 'Reject' }))
    expect(session.answerVoiceApproval).toHaveBeenLastCalledWith(false)
    fireEvent.click(within(block).getByRole('button', { name: 'Approve' }))
    expect(session.answerVoiceApproval).toHaveBeenLastCalledWith(true)
    expect(session.answerVoiceApproval).toHaveBeenCalledTimes(2)
  })

  it('a running tool is the tool block of the chat, and a finished one says how it ended', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(...live(), { type: 'tool-running', id: 'call-1', name: 'web_search' })
    // Plain words in the status line. The technical name stays out of it.
    expect(view.getByTestId('voice-status').textContent).toBe('Searching')
    const block = () => view.getByRole('group', { name: 'Tools' }).querySelector('[data-tool="web_search"]') as HTMLElement
    expect(block().getAttribute('data-status')).toBe('running')
    // The look of the chat: what it does in the shimmer (CA U1: words, the
    // internal name is the tooltip), the three dots.
    expect(block().querySelector('.lu-tool-shimmer')?.textContent).toBe('Searching the web for')
    expect(block().querySelector('[title="web_search"]')).not.toBeNull()
    expect(block().querySelectorAll('.lu-band-dot')).toHaveLength(3)
    send({ type: 'tool-done', id: 'call-1', status: 'failed', result: 'No connection.', durationMs: 1200 })
    expect(block().getAttribute('data-status')).toBe('failed')
    expect(block().textContent).toContain('1.2s')
    expect(block().querySelector('.lu-tool-shimmer')).toBeNull()
    // Closed until it is opened, as in the chat.
    expect(block().textContent).not.toContain('No connection.')
    fireEvent.click(within(block()).getByRole('button'))
    expect(block().textContent).toContain('No connection.')
  })

  it('tool calls stand where they happened, and calls in a row fold into one band', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(
      ...live(),
      { type: 'user-text', text: 'Save my list.', final: true },
      { type: 'tool-running', id: 'call-1', name: 'file_write', args: { path: 'shopping.txt', content: 'milk\nbread' } },
      { type: 'tool-done', id: 'call-1', status: 'completed', result: 'Wrote 2 lines.', durationMs: 30 },
      { type: 'tool-running', id: 'call-2', name: 'file_read', args: { path: 'shopping.txt' } },
      { type: 'tool-done', id: 'call-2', status: 'completed', result: 'milk\nbread', durationMs: 20 },
      { type: 'bot-text', text: 'Saved.' },
      { type: 'bot-silent' },
      { type: 'tool-running', id: 'call-3', name: 'web_search', args: { query: 'bread recipe' } },
    )
    const order = [...view.getByRole('list', { name: 'Transcript' }).children].map((node) => node.getAttribute('data-role') ?? node.querySelector('[role="group"]')?.getAttribute('aria-label'))
    expect(order).toEqual(['user', 'Earlier tools', 'assistant', 'Tools'])
    const first = view.getByRole('group', { name: 'Earlier tools' })
    expect(first.textContent).toContain('2 steps')
    expect(first.textContent).toContain('50ms')
    expect(first.querySelector('[data-tool]')).toBeNull()
    fireEvent.click(within(first).getByRole('button'))
    expect([...first.querySelectorAll('[data-tool]')].map((node) => node.getAttribute('data-tool'))).toEqual(['file_write', 'file_read'])
    expect(view.getByRole('group', { name: 'Tools' }).querySelector('[data-tool="web_search"]')).not.toBeNull()
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('a model without tools says so in one line, next to the latency', () => {
    const view = render(createElement(VoiceSessionPanel))
    send({ type: 'start', at: Date.now(), muted: false }, { type: 'brain', modelLabel: 'Tiny', notice: 'This model cannot use tools, so this session is conversation only.' }, { type: 'ready' }, { type: 'latency', ms: 1840 })
    expect(view.getByTestId('voice-notice').textContent).toBe('This model cannot use tools, so this session is conversation only.')
    expect(view.getByTestId('voice-latency').textContent).toBe('Answered in 1.8 s')
  })

  it('one answer that could not be spoken is a line under the status, the session stays live, and the line leaves with the next words', () => {
    const view = render(createElement(VoiceSessionPanel))
    send({ type: 'start', at: Date.now(), muted: false }, { type: 'brain', modelLabel: 'Tiny', notice: 'This model cannot use tools, so this session is conversation only.' }, { type: 'ready' })
    send({ type: 'hint', text: 'One answer could not be spoken. The session goes on.' })
    expect(view.getByTestId('voice-notice').textContent).toBe('One answer could not be spoken. The session goes on.')
    expect(view.getByTestId('voice-session').getAttribute('data-phase')).toBe('live')
    expect(view.queryByRole('alert')).toBeNull()
    send({ type: 'user-started' })
    expect(view.getByTestId('voice-notice').textContent).toBe('This model cannot use tools, so this session is conversation only.')
  })

  it('a blocked microphone: the error, what to do about it, and a way to start again', () => {
    const view = render(createElement(VoiceSessionPanel))
    send({ type: 'start', at: Date.now(), muted: false }, { type: 'failed', error: { kind: 'microphone-denied', message: 'LU is not allowed to use the microphone.' } })
    const alert = view.getByRole('alert').textContent ?? ''
    expect(alert).toContain('LU is not allowed to use the microphone.')
    expect(alert).toMatch(/Then start again\.$/)
    fireEvent.click(view.getByRole('button', { name: 'Start again' }))
    expect(session.startVoiceSession).toHaveBeenCalledTimes(1)
  })

  it('a blocked microphone on Linux points at the sound settings, not at a privacy switch Linux does not have (#162)', () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')
    try {
      const view = render(createElement(VoiceSessionPanel))
      send({ type: 'start', at: Date.now(), muted: false }, { type: 'failed', error: { kind: 'microphone-denied', message: 'LU is not allowed to use the microphone.' } })
      const alert = view.getByRole('alert').textContent ?? ''
      expect(alert).toContain('chosen as the input in the sound settings')
      expect(alert).not.toMatch(/privacy/i)
      expect(alert).toMatch(/Then start again\.$/)
    } finally {
      agent.mockRestore()
    }
  })

  it('the empty surface gives one calm line of advice for a small chat model, and none while a session runs', () => {
    useModelStore.setState({ activeModel: 'openai::Qwen3-4B-Q4_K_M', models: [] })
    const view = render(createElement(VoiceSessionPanel))
    expect(view.getAllByTestId('voice-model-advice')).toHaveLength(1)
    expect(view.getByTestId('voice-model-advice').textContent).toBe('Small models often miss tool calls. Voice works best with a local model from 7B up, such as Qwen 3.5 9B.')
    send(...live())
    expect(view.queryByTestId('voice-model-advice')).toBeNull()
    act(() => { useModelStore.setState({ activeModel: null }) })
  })

  it('a 9B chat model gets no advice', () => {
    useModelStore.setState({ activeModel: 'openai::Qwen3.5-9B-Q4_K_M', models: [] })
    const view = render(createElement(VoiceSessionPanel))
    expect(view.queryByTestId('voice-model-advice')).toBeNull()
    act(() => { useModelStore.setState({ activeModel: null }) })
  })

  it('leaving the surface ends the session', () => {
    const view = render(createElement(VoiceSessionPanel))
    view.unmount()
    expect(session.stopVoiceSession).toHaveBeenCalledTimes(1)
    // With the reason, so the surface can say why the session is over.
    expect(session.stopVoiceSession).toHaveBeenCalledWith('left')
  })

  it('a session that ended by itself says why and offers Start again', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(...live(), { type: 'stopping' }, { type: 'stopped', note: 'The session ended when you left Voice. Start again to continue.' })
    expect(view.getByTestId('voice-status').textContent).toBe('The session ended when you left Voice. Start again to continue.')
    fireEvent.click(view.getByRole('button', { name: 'Start again' }))
    expect(session.startVoiceSession).toHaveBeenCalledTimes(1)
  })

  it('after the Stop button the surface is simply ready again', () => {
    const view = render(createElement(VoiceSessionPanel))
    send(...live(), { type: 'stopping' }, { type: 'stopped' })
    expect(view.getByTestId('voice-status').textContent).toBe('Ready')
    expect(view.getByRole('button', { name: 'Start voice' })).toBeTruthy()
  })
})
