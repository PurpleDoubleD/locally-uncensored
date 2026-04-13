import { describe, it, expect, beforeEach } from 'vitest'
import { usePermissionStore } from '../permissionStore'
import { DEFAULT_PERMISSIONS } from '../../api/mcp/types'

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
