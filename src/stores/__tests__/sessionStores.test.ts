import { describe, it, expect, beforeEach } from 'vitest'
import { useCodexStore } from '../codexStore'
import { useClaudeCodeStore } from '../claudeCodeStore'
import type { ClaudeCodeEvent } from '../claudeCodeStore'
import { useVoiceStore } from '../voiceStore'
import type { CodexEvent } from '../../types/codex'

// ── codexStore ───────────────────────────────────────────────

describe('codexStore', () => {
  beforeEach(() => {
    useCodexStore.setState({
      chatMode: 'lu',
      threads: {},
      workingDirectory: '',
      fileTree: [],
    })
  })

  describe('initThread', () => {
    it('creates a new thread for the conversation', () => {
      const id = useCodexStore.getState().initThread('conv-1', '/home/user')
      expect(id).toMatch(/^codex-/)
      const thread = useCodexStore.getState().threads['conv-1']
      expect(thread).toBeDefined()
      expect(thread.conversationId).toBe('conv-1')
      expect(thread.workingDirectory).toBe('/home/user')
      expect(thread.status).toBe('idle')
      expect(thread.events).toEqual([])
    })

    it('overwrites existing thread for same conversation', () => {
      useCodexStore.getState().initThread('conv-1', '/path/a')
      const id2 = useCodexStore.getState().initThread('conv-1', '/path/b')
      expect(useCodexStore.getState().threads['conv-1'].id).toBe(id2)
      expect(useCodexStore.getState().threads['conv-1'].workingDirectory).toBe('/path/b')
    })

    it('does not affect other conversations threads', () => {
      useCodexStore.getState().initThread('conv-1', '/a')
      useCodexStore.getState().initThread('conv-2', '/b')
      expect(Object.keys(useCodexStore.getState().threads)).toHaveLength(2)
    })
  })

  describe('addEvent', () => {
    it('appends an event to the correct thread', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      const event: CodexEvent = {
        id: 'e1',
        type: 'instruction',
        content: 'hello',
        timestamp: Date.now(),
      }
      useCodexStore.getState().addEvent('conv-1', event)
      expect(useCodexStore.getState().threads['conv-1'].events).toHaveLength(1)
      expect(useCodexStore.getState().threads['conv-1'].events[0].id).toBe('e1')
    })

    it('gracefully returns state when thread does not exist', () => {
      const event: CodexEvent = { id: 'e1', type: 'error', content: 'err', timestamp: Date.now() }
      useCodexStore.getState().addEvent('nonexistent', event)
      // Should not throw, no new thread created
      expect(useCodexStore.getState().threads['nonexistent']).toBeUndefined()
    })

    it('preserves event order', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      useCodexStore.getState().addEvent('conv-1', { id: 'a', type: 'instruction', content: '1', timestamp: 1 })
      useCodexStore.getState().addEvent('conv-1', { id: 'b', type: 'file_change', content: '2', timestamp: 2 })
      useCodexStore.getState().addEvent('conv-1', { id: 'c', type: 'done', content: '3', timestamp: 3 })
      const events = useCodexStore.getState().threads['conv-1'].events
      expect(events.map(e => e.id)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('setThreadStatus', () => {
    it('updates the thread status', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      useCodexStore.getState().setThreadStatus('conv-1', 'running')
      expect(useCodexStore.getState().threads['conv-1'].status).toBe('running')
    })

    it('is a no-op for non-existent thread', () => {
      useCodexStore.getState().setThreadStatus('nonexistent', 'error')
      expect(useCodexStore.getState().threads['nonexistent']).toBeUndefined()
    })

    it('can transition through multiple statuses', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      useCodexStore.getState().setThreadStatus('conv-1', 'running')
      useCodexStore.getState().setThreadStatus('conv-1', 'error')
      expect(useCodexStore.getState().threads['conv-1'].status).toBe('error')
    })
  })

  describe('getThread', () => {
    it('returns the thread for the conversation', () => {
      useCodexStore.getState().initThread('conv-1', '/home')
      const thread = useCodexStore.getState().getThread('conv-1')
      expect(thread).toBeDefined()
      expect(thread!.conversationId).toBe('conv-1')
    })

    it('returns undefined for non-existent conversation', () => {
      expect(useCodexStore.getState().getThread('nope')).toBeUndefined()
    })
  })

  describe('setChatMode', () => {
    it('updates the chat mode', () => {
      useCodexStore.getState().setChatMode('codex')
      expect(useCodexStore.getState().chatMode).toBe('codex')
    })
  })
})

// ── claudeCodeStore ──────────────────────────────────────────

describe('claudeCodeStore', () => {
  beforeEach(() => {
    useClaudeCodeStore.setState({
      installed: false,
      version: null,
      cliPath: null,
      sessions: {},
      workingDirectory: '',
    })
  })

  describe('initSession', () => {
    it('creates a new session for the conversation', () => {
      const id = useClaudeCodeStore.getState().initSession('conv-1', '/workspace')
      expect(id).toMatch(/^claude-code-/)
      const session = useClaudeCodeStore.getState().sessions['conv-1']
      expect(session).toBeDefined()
      expect(session.conversationId).toBe('conv-1')
      expect(session.workingDirectory).toBe('/workspace')
      expect(session.status).toBe('idle')
      expect(session.pid).toBeNull()
      expect(session.events).toEqual([])
    })

    it('overwrites an existing session for the same conversation', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/a')
      const id2 = useClaudeCodeStore.getState().initSession('conv-1', '/b')
      expect(useClaudeCodeStore.getState().sessions['conv-1'].id).toBe(id2)
    })
  })

  describe('addEvent', () => {
    it('appends an event to the correct session', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/ws')
      const event: ClaudeCodeEvent = {
        id: 'e1',
        type: 'text',
        content: 'Hello',
        timestamp: Date.now(),
      }
      useClaudeCodeStore.getState().addEvent('conv-1', event)
      expect(useClaudeCodeStore.getState().sessions['conv-1'].events).toHaveLength(1)
    })

    it('gracefully returns state when session does not exist', () => {
      const event: ClaudeCodeEvent = { id: 'e1', type: 'error', content: 'err', timestamp: Date.now() }
      useClaudeCodeStore.getState().addEvent('nonexistent', event)
      expect(useClaudeCodeStore.getState().sessions['nonexistent']).toBeUndefined()
    })

    it('preserves event order', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/ws')
      useClaudeCodeStore.getState().addEvent('conv-1', { id: 'a', type: 'text', content: '1', timestamp: 1 })
      useClaudeCodeStore.getState().addEvent('conv-1', { id: 'b', type: 'tool_use', content: '2', timestamp: 2, toolName: 'file_read' })
      const events = useClaudeCodeStore.getState().sessions['conv-1'].events
      expect(events.map(e => e.id)).toEqual(['a', 'b'])
    })
  })

  describe('clearSession', () => {
    it('removes the session for the conversation', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/ws')
      useClaudeCodeStore.getState().clearSession('conv-1')
      expect(useClaudeCodeStore.getState().sessions['conv-1']).toBeUndefined()
    })

    it('does not affect other sessions', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/a')
      useClaudeCodeStore.getState().initSession('conv-2', '/b')
      useClaudeCodeStore.getState().clearSession('conv-1')
      expect(useClaudeCodeStore.getState().sessions['conv-2']).toBeDefined()
    })

    it('is a no-op for non-existent conversation', () => {
      useClaudeCodeStore.getState().clearSession('nonexistent')
      expect(Object.keys(useClaudeCodeStore.getState().sessions)).toHaveLength(0)
    })
  })

  describe('getSession', () => {
    it('returns the session for the conversation', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/ws')
      expect(useClaudeCodeStore.getState().getSession('conv-1')).toBeDefined()
    })

    it('returns undefined for non-existent conversation', () => {
      expect(useClaudeCodeStore.getState().getSession('nope')).toBeUndefined()
    })
  })

  describe('setSessionStatus', () => {
    it('updates the session status', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/ws')
      useClaudeCodeStore.getState().setSessionStatus('conv-1', 'running')
      expect(useClaudeCodeStore.getState().sessions['conv-1'].status).toBe('running')
    })

    it('is a no-op for non-existent session', () => {
      useClaudeCodeStore.getState().setSessionStatus('nonexistent', 'error')
      expect(useClaudeCodeStore.getState().sessions['nonexistent']).toBeUndefined()
    })
  })

  describe('setSessionPid', () => {
    it('sets the pid on the session', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/ws')
      useClaudeCodeStore.getState().setSessionPid('conv-1', 12345)
      expect(useClaudeCodeStore.getState().sessions['conv-1'].pid).toBe(12345)
    })

    it('can clear pid to null', () => {
      useClaudeCodeStore.getState().initSession('conv-1', '/ws')
      useClaudeCodeStore.getState().setSessionPid('conv-1', 123)
      useClaudeCodeStore.getState().setSessionPid('conv-1', null)
      expect(useClaudeCodeStore.getState().sessions['conv-1'].pid).toBeNull()
    })
  })

  describe('setInstalled', () => {
    it('sets installed status with version and path', () => {
      useClaudeCodeStore.getState().setInstalled(true, '1.0.0', '/usr/bin/claude')
      const state = useClaudeCodeStore.getState()
      expect(state.installed).toBe(true)
      expect(state.version).toBe('1.0.0')
      expect(state.cliPath).toBe('/usr/bin/claude')
    })

    it('sets null for missing version and path', () => {
      useClaudeCodeStore.getState().setInstalled(false)
      expect(useClaudeCodeStore.getState().version).toBeNull()
      expect(useClaudeCodeStore.getState().cliPath).toBeNull()
    })
  })
})

// ── voiceStore ───────────────────────────────────────────────

describe('voiceStore', () => {
  beforeEach(() => {
    useVoiceStore.setState({
      isRecording: false,
      isTranscribing: false,
      isSpeaking: false,
      transcript: '',
      sttEnabled: true,
      ttsEnabled: false,
      ttsVoice: '',
      ttsRate: 1.0,
      ttsPitch: 1.0,
      autoSendOnTranscribe: true,
    })
  })

  describe('updateVoiceSettings', () => {
    it('partially merges settings', () => {
      useVoiceStore.getState().updateVoiceSettings({ ttsEnabled: true, ttsVoice: 'en-US' })
      expect(useVoiceStore.getState().ttsEnabled).toBe(true)
      expect(useVoiceStore.getState().ttsVoice).toBe('en-US')
      // Others unchanged
      expect(useVoiceStore.getState().sttEnabled).toBe(true)
    })

    it('can update rate and pitch', () => {
      useVoiceStore.getState().updateVoiceSettings({ ttsRate: 1.5, ttsPitch: 0.8 })
      expect(useVoiceStore.getState().ttsRate).toBe(1.5)
      expect(useVoiceStore.getState().ttsPitch).toBe(0.8)
    })

    it('can disable autoSendOnTranscribe', () => {
      useVoiceStore.getState().updateVoiceSettings({ autoSendOnTranscribe: false })
      expect(useVoiceStore.getState().autoSendOnTranscribe).toBe(false)
    })
  })

  describe('resetTransient', () => {
    it('resets transient state to defaults', () => {
      useVoiceStore.setState({
        isRecording: true,
        isTranscribing: true,
        isSpeaking: true,
        transcript: 'some text',
      })
      useVoiceStore.getState().resetTransient()
      expect(useVoiceStore.getState().isRecording).toBe(false)
      expect(useVoiceStore.getState().isTranscribing).toBe(false)
      expect(useVoiceStore.getState().isSpeaking).toBe(false)
      expect(useVoiceStore.getState().transcript).toBe('')
    })

    it('preserves persisted settings', () => {
      useVoiceStore.getState().updateVoiceSettings({ ttsEnabled: true, ttsVoice: 'custom', ttsRate: 2.0 })
      useVoiceStore.setState({ isRecording: true, isSpeaking: true })
      useVoiceStore.getState().resetTransient()
      expect(useVoiceStore.getState().ttsEnabled).toBe(true)
      expect(useVoiceStore.getState().ttsVoice).toBe('custom')
      expect(useVoiceStore.getState().ttsRate).toBe(2.0)
    })
  })

  describe('individual setters', () => {
    it('setRecording updates isRecording', () => {
      useVoiceStore.getState().setRecording(true)
      expect(useVoiceStore.getState().isRecording).toBe(true)
    })

    it('setTranscribing updates isTranscribing', () => {
      useVoiceStore.getState().setTranscribing(true)
      expect(useVoiceStore.getState().isTranscribing).toBe(true)
    })

    it('setSpeaking updates isSpeaking', () => {
      useVoiceStore.getState().setSpeaking(true)
      expect(useVoiceStore.getState().isSpeaking).toBe(true)
    })

    it('setTranscript updates transcript', () => {
      useVoiceStore.getState().setTranscript('hello world')
      expect(useVoiceStore.getState().transcript).toBe('hello world')
    })
  })
})
