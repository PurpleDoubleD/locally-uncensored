import { describe, it, expect, beforeEach } from 'vitest'
import {
  usePermissionStore,
  MODE_SCOPE_ALLOWED_CATEGORIES,
  modeAllowsCategory,
} from '../permissionStore'

describe('permissionStore — Phase 12 per-tool overrides', () => {
  beforeEach(() => {
    usePermissionStore.getState().resetToDefaults()
  })

  it('setToolOverride stores a per-tool level', () => {
    usePermissionStore.getState().setToolOverride('file_write', 'auto')
    expect(usePermissionStore.getState().perToolOverrides['file_write']).toBe('auto')
  })

  it('clearToolOverride removes the entry', () => {
    const s = usePermissionStore.getState()
    s.setToolOverride('file_write', 'auto')
    s.clearToolOverride('file_write')
    expect(usePermissionStore.getState().perToolOverrides['file_write']).toBeUndefined()
  })

  it('getEffectivePermissionForTool returns the override when set', () => {
    const s = usePermissionStore.getState()
    s.setToolOverride('file_write', 'auto')
    // Even if category default would be 'confirm', override wins.
    s.setGlobalPermission('filesystem', 'confirm')
    const level = usePermissionStore
      .getState()
      .getEffectivePermissionForTool('file_write', 'filesystem')
    expect(level).toBe('auto')
  })

  it('getEffectivePermissionForTool falls back to category when no override', () => {
    usePermissionStore.getState().setGlobalPermission('terminal', 'auto')
    const level = usePermissionStore
      .getState()
      .getEffectivePermissionForTool('shell_execute', 'terminal')
    expect(level).toBe('auto')
  })

  it('resetToDefaults clears per-tool overrides', () => {
    const s = usePermissionStore.getState()
    s.setToolOverride('file_write', 'auto')
    s.resetToDefaults()
    expect(usePermissionStore.getState().perToolOverrides).toEqual({})
  })

  it('per-conversation override still applies on top of global when no per-tool override', () => {
    const s = usePermissionStore.getState()
    s.setGlobalPermission('filesystem', 'confirm')
    s.setConversationOverride('c1', 'filesystem', 'auto')
    // No per-tool override → resolves through per-conv layer.
    const lvl = usePermissionStore
      .getState()
      .getEffectivePermissionForTool('file_read', 'filesystem', 'c1')
    expect(lvl).toBe('auto')
  })
})

describe('permissionStore — Phase 12 mode scopes', () => {
  beforeEach(() => {
    usePermissionStore.getState().resetToDefaults()
  })

  it('defaults to agent mode', () => {
    expect(usePermissionStore.getState().modeScope).toBe('agent')
  })

  it('setModeScope mutates the field', () => {
    usePermissionStore.getState().setModeScope('chat')
    expect(usePermissionStore.getState().modeScope).toBe('chat')
  })

  it('chat scope allows web + system only', () => {
    expect(modeAllowsCategory('chat', 'web')).toBe(true)
    expect(modeAllowsCategory('chat', 'system')).toBe(true)
    expect(modeAllowsCategory('chat', 'filesystem')).toBe(false)
    expect(modeAllowsCategory('chat', 'terminal')).toBe(false)
    expect(modeAllowsCategory('chat', 'image')).toBe(false)
  })

  it('edit scope adds filesystem', () => {
    expect(modeAllowsCategory('edit', 'filesystem')).toBe(true)
    expect(modeAllowsCategory('edit', 'terminal')).toBe(false)
    expect(modeAllowsCategory('edit', 'image')).toBe(false)
  })

  it('agent scope allows every category', () => {
    const all: ReadonlyArray<string> = [
      'filesystem', 'terminal', 'desktop', 'web', 'system', 'image', 'video', 'workflow',
    ]
    for (const c of all) expect(modeAllowsCategory('agent', c as any)).toBe(true)
  })

  it('allowed-category table is monotonic chat ⊆ edit ⊆ agent', () => {
    const chat = new Set(MODE_SCOPE_ALLOWED_CATEGORIES.chat)
    const edit = new Set(MODE_SCOPE_ALLOWED_CATEGORIES.edit)
    const agent = new Set(MODE_SCOPE_ALLOWED_CATEGORIES.agent)
    for (const c of chat) expect(edit.has(c)).toBe(true)
    for (const c of edit) expect(agent.has(c)).toBe(true)
  })
})
