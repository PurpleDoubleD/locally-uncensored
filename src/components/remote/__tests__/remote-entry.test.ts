import { describe, it, expect } from 'vitest'
import { showsRemoteEntry } from '../remote-entry'

const empty = { id: 'a', mode: 'remote', messages: [] }
const withHistory = { id: 'b', mode: 'remote', messages: [{}] }
const plainChat = { id: 'c', mode: 'lu', messages: [] }

describe('the Remote entry screen', () => {
  it('shows with no chat open', () => {
    expect(showsRemoteEntry('remote', null, null, false)).toBe(true)
  })
  it('shows for an empty Remote chat no phone is attached to', () => {
    expect(showsRemoteEntry('remote', empty, null, false)).toBe(true)
    expect(showsRemoteEntry('remote', empty, 'a', false)).toBe(true)
    expect(showsRemoteEntry('remote', empty, 'other', true)).toBe(true)
  })
  it('gives way to the live session, even before its first message', () => {
    expect(showsRemoteEntry('remote', empty, 'a', true)).toBe(false)
  })
  it('keeps a Remote chat with history open', () => {
    expect(showsRemoteEntry('remote', withHistory, null, false)).toBe(false)
  })
  it('never shows outside Remote', () => {
    expect(showsRemoteEntry('lu', null, null, false)).toBe(false)
    expect(showsRemoteEntry('codex', empty, null, false)).toBe(false)
    expect(showsRemoteEntry('lu', plainChat, null, false)).toBe(false)
  })
})
