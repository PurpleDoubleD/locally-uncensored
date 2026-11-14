/**
 * #232: over the internet only the LU app gets through (sealed channel, E3).
 * The tunnel address has no browser page, so the panel used to hand out an
 * address that showed a blank screen on the phone. Now the panel shows the
 * Wi-Fi address for the browser and says that the internet takes the app.
 *
 * Run: npx vitest run src/components/layout/__tests__/internet-takes-only-the-app.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const mockBackendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (...args: unknown[]) => mockBackendCall(...args),
  isTauri: () => true,
}))

import { useRemoteStore, remoteAddressView, INTERNET_APP_ONLY_HINT } from '../../../stores/remoteStore'

const ROOT = path.join(__dirname, '..', '..', '..', '..')
const SIDEBAR = fs.readFileSync(path.join(ROOT, 'src', 'components', 'layout', 'Sidebar.tsx'), 'utf8')

const LAN = { mobileUrl: 'http://192.168.1.20:11435/mobile', lanUrl: 'http://192.168.1.20:11435' }

describe('the panel hint for the internet way', () => {
  it('says that the internet takes the LU app and a browser the same Wi-Fi', () => {
    expect(INTERNET_APP_ONLY_HINT).toBe('Internet works only with the LU app. A browser on your phone needs the same Wi-Fi.')
    expect(INTERNET_APP_ONLY_HINT).not.toMatch(/[–—]/)
  })

  it('shows the hint and the Wi-Fi address while the tunnel runs', () => {
    const v = remoteAddressView({ tunnelActive: true, ...LAN })
    expect(v.appOnlyHint).toBe(INTERNET_APP_ONLY_HINT)
    expect(v.address).toBe(LAN.mobileUrl)
    expect(v.address).not.toContain('trycloudflare')
  })

  it('shows the hint when the QR answer says internetAppOnly', () => {
    expect(remoteAddressView({ tunnelActive: false, internetAppOnly: true, ...LAN }).appOnlyHint).toBe(INTERNET_APP_ONLY_HINT)
  })

  // Negative control: in the Wi-Fi only mode there is nothing to explain.
  it('has no hint without the tunnel', () => {
    const v = remoteAddressView({ tunnelActive: false, internetAppOnly: false, ...LAN })
    expect(v.appOnlyHint).toBe('')
    expect(v.address).toBe(LAN.mobileUrl)
    expect(remoteAddressView({ tunnelActive: false, mobileUrl: '', lanUrl: LAN.lanUrl }).address).toBe(LAN.lanUrl)
  })
})

describe('the store keeps internetAppOnly from remote_qr_code', () => {
  beforeEach(() => {
    mockBackendCall.mockReset()
    useRemoteStore.setState({ internetAppOnly: false, qrPngBase64: '' })
  })

  it('takes the flag from the desktop answer', async () => {
    mockBackendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'remote_qr_code') return { qr_png_base64: 'QQ', url: LAN.mobileUrl, passcode: '123456', internetAppOnly: true }
      throw new Error('no app qr here')
    })
    await useRemoteStore.getState().fetchQrCode()
    expect(useRemoteStore.getState().internetAppOnly).toBe(true)
    expect(useRemoteStore.getState().qrPngBase64).toBe('QQ')
  })

  it('reads a missing or odd flag as false', async () => {
    useRemoteStore.setState({ internetAppOnly: true })
    mockBackendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'remote_qr_code') return { qr_png_base64: 'QQ', url: LAN.mobileUrl, passcode: '', internetAppOnly: 'yes' }
      throw new Error('no app qr here')
    })
    await useRemoteStore.getState().fetchQrCode()
    expect(useRemoteStore.getState().internetAppOnly).toBe(false)
  })
})

describe('the Sidebar panel', () => {
  it('takes its address and hint from remoteAddressView', () => {
    expect(SIDEBAR).toContain('remoteAddressView({ tunnelActive, internetAppOnly, mobileUrl, lanUrl })')
    // Small panel and large QR both say it.
    expect(SIDEBAR.match(/\{appOnlyHint\}/g)?.length).toBe(2)
  })

  // Negative control: the tunnel address is no longer handed out as the
  // address to open.
  it('no longer shows the tunnel address as the address to open', () => {
    expect(SIDEBAR).not.toMatch(/tunnelActive && tunnelUrl \? tunnelUrl/)
    expect(SIDEBAR).not.toMatch(/copyToClipboard\(tunnelUrl/)
  })

  it('keeps the hint grey like the notes around it, not yellow', () => {
    const lines = SIDEBAR.split('\n').filter((l) => l.includes('{appOnlyHint}'))
    expect(lines[0]).toContain('t-micro text-gray-500')
    for (const l of lines) expect(l).not.toMatch(/amber|yellow/)
    // The large QR: inside the grey note under the address.
    const modal = SIDEBAR.slice(SIDEBAR.indexOf('<span className="block mb-1.25">{appOnlyHint}</span>') - 120)
    expect(modal.slice(0, 120)).toContain('text-gray-500')
  })
})
