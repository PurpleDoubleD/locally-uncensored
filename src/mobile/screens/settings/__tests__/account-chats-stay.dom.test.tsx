// @vitest-environment jsdom
/**
 * M310: the account keeps credits and memories, never chats. A customer who
 * uses lu-labs.ai in the browser and the phone app sees the same balance but
 * not the same chats; the page Account says so, and where a chat of the
 * computer shows up instead (Remote desktop) when the build offers it.
 *
 * Run: npx vitest run src/mobile/screens/settings/__tests__/account-chats-stay.dom.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../../../../hooks/useCloudAuth', () => ({ probeAccount: vi.fn(async () => {}), signOutAccount: vi.fn(async () => {}) }))

import { useCloudAuthStore } from '../../../../stores/cloudAuthStore'
import { setStorePresetForTests, storePolicy } from '../../../policy'
import { SETTINGS_STRINGS } from '../../../strings/settings'
import AccountPage from '../AccountPage'

const T = SETTINGS_STRINGS.account

afterEach(() => { cleanup(); setStorePresetForTests(null) })

describe('the page Account says chats stay on the phone', () => {
  it.each(['open', 'play', 'appstore'] as const)('preset %s', (preset) => {
    setStorePresetForTests(preset)
    useCloudAuthStore.setState({ status: 'signed-in', user: { id: 'u1', email: 'someone@example.com' }, offline: false, licenseActive: true, access: true, pastDue: false } as never)
    render(<AccountPage />)
    const row = screen.getByTestId('m-account-chats-stay')
    expect(row.textContent).toContain(T.chatsStayHere)
    expect(row.textContent).toContain(storePolicy().remoteDesktop ? T.chatsStayHereSubRemote : T.chatsStayHereSub)
    expect(row.textContent).not.toMatch(/sync/i)
  })
})
