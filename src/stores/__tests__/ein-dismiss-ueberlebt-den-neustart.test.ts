// @vitest-environment jsdom
// T1 Nacht-Durchtest 3.0.9: ein Update 3.0.10 mit "Dismiss" weggeklickt, App
// beendet und neu gestartet, und der Hinweis stand wieder oben rechts.
// `dismissed` fehlte in `partialize`, also vergass der Store die Antwort des
// Nutzers bei jedem Start.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/backend', () => ({ isTauri: () => false, backendCall: vi.fn(), openExternal: vi.fn() }))

import { useUpdateStore } from '../updateStore'

describe('Dismiss on an update', () => {
  it('is written to storage, so the next start still knows it', () => {
    useUpdateStore.setState({ latestVersion: '3.0.10', updateAvailable: true, dismissed: null })
    useUpdateStore.getState().dismissUpdate()
    const raw = JSON.parse(localStorage.getItem('lu-update-checker-v2') || '{}')
    expect(raw.state?.dismissed).toBe('3.0.10')
  })
})
