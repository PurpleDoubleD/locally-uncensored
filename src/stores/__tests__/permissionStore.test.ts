import { describe, it, expect, beforeEach } from 'vitest'
import { usePermissionStore, migratePermissionState } from '../permissionStore'
import { DEFAULT_PERMISSIONS } from '../../api/mcp/types'

// v2.5.3 — video generation went live. The default must not be 'blocked'
// anymore (it removes video_generate from every model's tool list), and the
// persist migration must lift the old locked-in 'blocked' for existing users.
describe('video category unlock (v2.5.3)', () => {
  it('DEFAULT_PERMISSIONS.video is confirm (same gate as image)', () => {
    expect(DEFAULT_PERMISSIONS.video).toBe('confirm')
    expect(DEFAULT_PERMISSIONS.image).toBe('confirm')
  })

  it('migrate lifts a persisted v1 video:blocked to the new default', () => {
    const persisted = {
      globalPermissions: { ...DEFAULT_PERMISSIONS, video: 'blocked', terminal: 'auto' },
      conversationOverrides: { c1: { web: 'blocked' } },
    }
    const migrated = migratePermissionState(persisted, 1)
    // The locked-in old default is lifted…
    expect(migrated.globalPermissions.video).toBe('confirm')
    // …while real user choices survive untouched.
    expect(migrated.globalPermissions.terminal).toBe('auto')
    expect(migrated.conversationOverrides.c1.web).toBe('blocked')
  })

  it('migrate is a no-op for current-version state', () => {
    const persisted = { globalPermissions: { ...DEFAULT_PERMISSIONS, video: 'blocked' } }
    const migrated = migratePermissionState(persisted, 2)
    expect(migrated.globalPermissions.video).toBe('blocked')
  })
})

// B12 (28.10.2026): MCP tools left 'workflow' for a row of their own. A saved
// Workflows: Auto must not carry over into running MCP tools unattended.
describe('MCP row migration (v4)', () => {
  it('Workflows on Auto becomes MCP on Ask First', () => {
    const { mcp: _none, ...v3 } = { ...DEFAULT_PERMISSIONS, workflow: 'auto', terminal: 'blocked' }
    const migrated = migratePermissionState({ globalPermissions: v3, conversationOverrides: { c1: { workflow: 'auto' } } }, 3)
    expect(migrated.globalPermissions.mcp).toBe('confirm')
    expect(migrated.globalPermissions.workflow).toBe('auto')
    expect(migrated.globalPermissions.terminal).toBe('blocked')
    expect(migrated.conversationOverrides.c1.mcp).toBeUndefined()
  })

  it('Workflows Blocked keeps MCP tools blocked, globally and per chat', () => {
    const { mcp: _none, ...v3 } = { ...DEFAULT_PERMISSIONS, workflow: 'blocked' }
    const migrated = migratePermissionState({ globalPermissions: v3, conversationOverrides: { c1: { workflow: 'blocked' } } }, 3)
    expect(migrated.globalPermissions.mcp).toBe('blocked')
    expect(migrated.conversationOverrides.c1.mcp).toBe('blocked')
  })

  it('a v4 choice for the MCP row is kept', () => {
    const migrated = migratePermissionState({ globalPermissions: { ...DEFAULT_PERMISSIONS, mcp: 'auto' } }, 4)
    expect(migrated.globalPermissions.mcp).toBe('auto')
  })
})

describe('permissionStore', () => {
  beforeEach(() => {
    usePermissionStore.setState({
      globalPermissions: { ...DEFAULT_PERMISSIONS },
      conversationOverrides: {},
    })
  })

  // ── getEffectivePermissions ────────────────────────────────

  describe('getEffectivePermissions', () => {
    it('returns global permissions when no conversationId provided', () => {
      const perms = usePermissionStore.getState().getEffectivePermissions()
      expect(perms).toEqual(DEFAULT_PERMISSIONS)
    })

    it('returns global permissions when conversation has no overrides', () => {
      const perms = usePermissionStore.getState().getEffectivePermissions('conv-1')
      expect(perms).toEqual(DEFAULT_PERMISSIONS)
    })

    it('merges conversation overrides with global permissions', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'filesystem', 'auto')
      const perms = usePermissionStore.getState().getEffectivePermissions('conv-1')
      expect(perms.filesystem).toBe('auto')
      // Other categories remain global defaults
      expect(perms.terminal).toBe(DEFAULT_PERMISSIONS.terminal)
      expect(perms.web).toBe(DEFAULT_PERMISSIONS.web)
    })

    it('conversation overrides take precedence over global', () => {
      usePermissionStore.getState().setGlobalPermission('terminal', 'auto')
      usePermissionStore.getState().setConversationOverride('conv-1', 'terminal', 'blocked')
      const perms = usePermissionStore.getState().getEffectivePermissions('conv-1')
      expect(perms.terminal).toBe('blocked')
    })

    it('different conversations have independent overrides', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'filesystem', 'auto')
      usePermissionStore.getState().setConversationOverride('conv-2', 'filesystem', 'blocked')

      const perms1 = usePermissionStore.getState().getEffectivePermissions('conv-1')
      const perms2 = usePermissionStore.getState().getEffectivePermissions('conv-2')
      expect(perms1.filesystem).toBe('auto')
      expect(perms2.filesystem).toBe('blocked')
    })

    it('returns global for conversation with cleared overrides', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'filesystem', 'blocked')
      usePermissionStore.getState().clearConversationOverrides('conv-1')
      const perms = usePermissionStore.getState().getEffectivePermissions('conv-1')
      expect(perms).toEqual(DEFAULT_PERMISSIONS)
    })
  })

  // ── setGlobalPermission ────────────────────────────────────

  describe('setGlobalPermission', () => {
    it('updates a specific category', () => {
      usePermissionStore.getState().setGlobalPermission('filesystem', 'auto')
      expect(usePermissionStore.getState().globalPermissions.filesystem).toBe('auto')
    })

    it('does not affect other categories', () => {
      usePermissionStore.getState().setGlobalPermission('filesystem', 'blocked')
      expect(usePermissionStore.getState().globalPermissions.terminal).toBe(DEFAULT_PERMISSIONS.terminal)
      expect(usePermissionStore.getState().globalPermissions.web).toBe(DEFAULT_PERMISSIONS.web)
    })

    it('overwrites a previous global value', () => {
      usePermissionStore.getState().setGlobalPermission('web', 'blocked')
      usePermissionStore.getState().setGlobalPermission('web', 'confirm')
      expect(usePermissionStore.getState().globalPermissions.web).toBe('confirm')
    })

    it('updated global is reflected in getEffectivePermissions without conversation', () => {
      usePermissionStore.getState().setGlobalPermission('system', 'blocked')
      const perms = usePermissionStore.getState().getEffectivePermissions()
      expect(perms.system).toBe('blocked')
    })
  })

  // ── setConversationOverride ────────────────────────────────

  describe('setConversationOverride', () => {
    it('sets an override for a specific conversation and category', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'terminal', 'blocked')
      expect(usePermissionStore.getState().conversationOverrides['conv-1']).toEqual({
        terminal: 'blocked',
      })
    })

    it('accumulates multiple overrides for the same conversation', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'terminal', 'blocked')
      usePermissionStore.getState().setConversationOverride('conv-1', 'web', 'blocked')
      const overrides = usePermissionStore.getState().conversationOverrides['conv-1']
      expect(overrides).toEqual({ terminal: 'blocked', web: 'blocked' })
    })

    it('overwrites existing override for same conversation + category', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'terminal', 'blocked')
      usePermissionStore.getState().setConversationOverride('conv-1', 'terminal', 'auto')
      expect(usePermissionStore.getState().conversationOverrides['conv-1']?.terminal).toBe('auto')
    })
  })

  // ── clearConversationOverrides ─────────────────────────────

  describe('clearConversationOverrides', () => {
    it('removes all overrides for the specified conversation', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'filesystem', 'auto')
      usePermissionStore.getState().setConversationOverride('conv-1', 'terminal', 'blocked')
      usePermissionStore.getState().clearConversationOverrides('conv-1')
      expect(usePermissionStore.getState().conversationOverrides['conv-1']).toBeUndefined()
    })

    it('does not affect overrides for other conversations', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'filesystem', 'auto')
      usePermissionStore.getState().setConversationOverride('conv-2', 'terminal', 'blocked')
      usePermissionStore.getState().clearConversationOverrides('conv-1')
      expect(usePermissionStore.getState().conversationOverrides['conv-2']).toEqual({
        terminal: 'blocked',
      })
    })

    it('is a no-op for a conversation with no overrides', () => {
      usePermissionStore.getState().clearConversationOverrides('nonexistent')
      expect(usePermissionStore.getState().conversationOverrides).toEqual({})
    })
  })

  // ── resetToDefaults ────────────────────────────────────────

  describe('resetToDefaults', () => {
    it('reverts globalPermissions to defaults', () => {
      usePermissionStore.getState().setGlobalPermission('filesystem', 'blocked')
      usePermissionStore.getState().setGlobalPermission('web', 'blocked')
      usePermissionStore.getState().resetToDefaults()
      expect(usePermissionStore.getState().globalPermissions).toEqual(DEFAULT_PERMISSIONS)
    })

    it('clears all conversationOverrides', () => {
      usePermissionStore.getState().setConversationOverride('conv-1', 'filesystem', 'auto')
      usePermissionStore.getState().setConversationOverride('conv-2', 'terminal', 'blocked')
      usePermissionStore.getState().resetToDefaults()
      expect(usePermissionStore.getState().conversationOverrides).toEqual({})
    })

    it('resets both global and overrides in a single call', () => {
      usePermissionStore.getState().setGlobalPermission('system', 'blocked')
      usePermissionStore.getState().setConversationOverride('conv-1', 'web', 'blocked')
      usePermissionStore.getState().resetToDefaults()
      expect(usePermissionStore.getState().globalPermissions).toEqual(DEFAULT_PERMISSIONS)
      expect(usePermissionStore.getState().conversationOverrides).toEqual({})
    })
  })
})

// v3 (2.6.6 tool merge) — per-tool overrides on retired names must land on
// shell_execute, most restrictive wins, because that is the tool their work
// actually runs through now.
describe('retired-name override lift (v3)', () => {
  it('lifts the strictest retired override onto shell_execute', () => {
    const persisted = {
      globalPermissions: { ...DEFAULT_PERMISSIONS },
      perToolOverrides: { git_push: 'confirm', run_tests: 'auto', git_commit: 'blocked' },
    }
    const migrated = migratePermissionState(persisted, 2)
    expect(migrated.perToolOverrides.shell_execute).toBe('blocked')
    expect(migrated.perToolOverrides.git_push).toBeUndefined()
    expect(migrated.perToolOverrides.run_tests).toBeUndefined()
    expect(migrated.perToolOverrides.git_commit).toBeUndefined()
  })

  it('never loosens an existing shell_execute override', () => {
    const persisted = {
      globalPermissions: { ...DEFAULT_PERMISSIONS },
      perToolOverrides: { shell_execute: 'blocked', git_push: 'auto' },
    }
    const migrated = migratePermissionState(persisted, 2)
    expect(migrated.perToolOverrides.shell_execute).toBe('blocked')
  })

  it('tightens a loose shell_execute override when a retired name was stricter', () => {
    const persisted = {
      globalPermissions: { ...DEFAULT_PERMISSIONS },
      perToolOverrides: { shell_execute: 'auto', git_push: 'confirm' },
    }
    const migrated = migratePermissionState(persisted, 2)
    expect(migrated.perToolOverrides.shell_execute).toBe('confirm')
  })

  it('leaves live-tool overrides alone and is a no-op at version 3', () => {
    const persisted = {
      globalPermissions: { ...DEFAULT_PERMISSIONS },
      perToolOverrides: { file_write: 'blocked', git_push: 'blocked' },
    }
    const same = migratePermissionState({ ...persisted, perToolOverrides: { ...persisted.perToolOverrides } }, 3)
    expect(same.perToolOverrides).toEqual({ file_write: 'blocked', git_push: 'blocked' })
    const migrated = migratePermissionState(persisted, 2)
    expect(migrated.perToolOverrides.file_write).toBe('blocked')
    expect(migrated.perToolOverrides.shell_execute).toBe('blocked')
  })
})
