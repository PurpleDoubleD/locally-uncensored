// @vitest-environment jsdom
/**
 * R5-51, Entscheid vom 12.09.2026: der Dialog bei leerem Guthaben
 * oeffnet die Preisseite und nicht die Aufladeseite.
 *
 * Der Knopf sprang bis dahin mitten in einen Kauf. Wer leer ist, hat aber die
 * Wahl zwischen einem Plan und einem Paket, und diese Wahl steht auf der
 * Preisseite. Geprueft wird die Adresse, die wirklich an den Browser geht.
 *
 * Run: npx vitest run src/components/layout/__tests__/der-leere-beutel-fuehrt-auf-die-preisseite.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const geoeffnet: string[] = []
vi.mock('../../../api/backend', () => ({ openExternal: (url: string) => { geoeffnet.push(url); return Promise.resolve() } }))

const { CreditsExhaustedModal } = await import('../CreditsExhaustedModal')
const { CREDITS_EXHAUSTED_EVENT, CREDITS_EXHAUSTED_MESSAGE } = await import('../../../lib/credits-exhausted')
const { CLOUD_BASE } = await import('../../../api/cloud/config')

afterEach(() => { cleanup(); geoeffnet.length = 0 })

describe('der Dialog bei leerem Guthaben', () => {
  it('fuehrt auf die Preisseite und nirgends in einen Kauf', () => {
    render(<CreditsExhaustedModal />)
    act(() => { window.dispatchEvent(new Event(CREDITS_EXHAUSTED_EVENT)) })
    fireEvent.click(screen.getByText('See plans and packs'))
    expect(geoeffnet, 'der Knopf hat nichts geoeffnet').toEqual([`${CLOUD_BASE}/pricing?utm_source=desktop&utm_medium=credits-empty`])
    // Negativkontrolle in dieselbe Richtung: kein Weg dieses Dialogs zeigt
    // noch auf die Aufladeseite, weder der Knopf noch der Satz im Verlauf.
    expect(geoeffnet[0], 'der Knopf springt wieder in den Kauf').not.toContain('/credits')
    expect(CREDITS_EXHAUSTED_MESSAGE, 'der Satz im Verlauf schickt in den Kauf').not.toContain('/credits')
    expect(CREDITS_EXHAUSTED_MESSAGE).toContain(`${CLOUD_BASE}/pricing`)
  })

  it('zeigt den Knopf erst, wenn das Ereignis kommt', () => {
    render(<CreditsExhaustedModal />)
    expect(screen.queryByText('See plans and packs')).toBeNull()
  })
})
