// What the agent changed in LU itself, and what it only asked for (C60, 3.1.0).
//
// One row per card: a setting, several settings, or an action (model switch,
// service start, download). Kept across restarts, newest first, capped. Shown
// under Settings → Agent ("Changes by the agent") with Undo per setting row.
// Holds names and display values only, never a key or token: the catalog has
// none of those (settings-catalog.ts LOCK_RULES), and an action row stores
// what the card showed.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

export const SETTINGS_AUDIT_MAX = 500

export type SettingsAuditOutcome = 'applied' | 'declined' | 'timeout' | 'refused' | 'undone' | 'failed'

export interface SettingsAuditRow {
  id: string
  at: number
  conversationId: string | null
  /** The chat model that asked. */
  model: string | null
  kind: 'setting' | 'action'
  /** Catalog key, or the action ("lu_models switch"). */
  key: string
  label: string
  from: string
  to: string
  /** Raw values for Undo of a setting row. */
  rawFrom?: unknown
  rawTo?: unknown
  outcome: SettingsAuditOutcome
  /** The run had read foreign content before it asked (C60 S3). */
  tainted?: string
  /** Why it was refused, short. */
  why?: string
}

interface SettingsAuditState {
  rows: SettingsAuditRow[]
  record: (row: Omit<SettingsAuditRow, 'id' | 'at'> & { at?: number }) => void
  markUndone: (id: string) => void
  clear: () => void
}

let seq = 0

export const useSettingsAuditStore = create<SettingsAuditState>()(
  persist(
    (set) => ({
      rows: [],
      record: (row) => set((s) => ({
        rows: [{ ...row, id: `sa-${Date.now().toString(36)}-${++seq}`, at: row.at ?? Date.now() }, ...s.rows].slice(0, SETTINGS_AUDIT_MAX),
      })),
      markUndone: (id) => set((s) => ({ rows: s.rows.map((r) => (r.id === id ? { ...r, outcome: 'undone' } : r)) })),
      clear: () => set({ rows: [] }),
    }),
    { name: 'lu-settings-audit', storage: safeJSONStorage(), version: 1 },
  ),
)
