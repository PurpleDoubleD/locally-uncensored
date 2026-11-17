// @vitest-environment jsdom
/**
 * 3.1.1, the owner's wish W40 (17.11.2026): local 3D says before the setup and
 * before a run when the PC does not fit TRELLIS.2. Anlass: an RX 6600 with 8 GB
 * waited long and then got "DefaultCPUAllocator: not enough memory" from a
 * loader. One quiet line, the way to LU Cloud 3D after it, setup and run stay
 * possible. Not on a Mac.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const env = vi.hoisted(() => ({ mac: false, cardGb: null as number | null, comfyOnCpu: false, cloudAvailable: false }))
vi.mock('../../../../api/mlx-image', async (orig) => ({
  ...(await orig<typeof import('../../../../api/mlx-image')>()),
  isMlxImageHost: () => env.mac,
}))
vi.mock('../../../../hooks/useGraphicsMemory', () => ({ useGraphicsCardGb: () => env.cardGb }))
vi.mock('../CreateContext', () => ({ useCreateExp: () => ({ comfyOnCpu: env.comfyOnCpu, cloudAvailable: env.cloudAvailable }) }))
vi.mock('../../../../api/funnel', () => ({ reportCloudGate: vi.fn() }))

import { ThreeDHardwareNotice } from '../ThreeDHardwareNotice'
import { SETUP_TEXT } from '../ThreeDStage'
import { threeDHardwareLine, TRELLIS_MIN_VRAM_GB } from '../../../../lib/three/three-d-hardware'
import { useCreateStore, type CreateIntent } from '../../../../stores/createStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useUIStore } from '../../../../stores/uiStore'

function show(intent: CreateIntent = '3d') {
  useCreateStore.getState().setIntent(intent)
  return render(<ThreeDHardwareNotice />)
}
const line = () => screen.queryByTestId('three-d-hardware')
const cloud = () => screen.queryByTestId('three-d-hardware-cloud')

beforeEach(() => {
  Object.assign(env, { mac: false, cardGb: null, comfyOnCpu: false, cloudAvailable: false })
  useSettingsStore.getState().updateSettings({ appMode: 'local', cloudTeasersEnabled: true })
  useCreateStore.setState({ backend: 'local' })
  useUIStore.setState({ cloudGateOpen: false })
})
afterEach(cleanup)

describe('the sentence', () => {
  it('names the card under 12 GB, and the processor', () => {
    expect(TRELLIS_MIN_VRAM_GB).toBe(12)
    expect(threeDHardwareLine({ cardGb: 8, comfyOnCpu: false })).toBe('Local 3D needs a graphics card with 12 GB or more. Yours has 8 GB.')
    expect(threeDHardwareLine({ cardGb: 24, comfyOnCpu: true })).toBe('Local 3D needs a graphics card with 12 GB or more. ComfyUI runs on the processor here.')
  })

  it('says nothing for 12 GB and more, or while nothing is known', () => {
    for (const cardGb of [12, 16, 24, null, 0]) expect(threeDHardwareLine({ cardGb, comfyOnCpu: false }), String(cardGb)).toBeNull()
  })

  it('the setup card names the 12 GB before the download', () => {
    expect(SETUP_TEXT.pcBody).toContain('12 GB or more')
  })
})

describe('the line in the 3D tab', () => {
  it('an 8 GB card: the line and the way to LU Cloud 3D', () => {
    env.cardGb = 8
    show()
    expect(line()?.textContent).toBe('Local 3D needs a graphics card with 12 GB or more. Yours has 8 GB.')
    expect(cloud()?.textContent).toBe('Use a LU Cloud 3D model instead.')
  })

  it('signed in: the button turns the tab to the cloud', () => {
    env.cardGb = 8
    env.cloudAvailable = true
    show()
    fireEvent.click(cloud()!)
    expect(useCreateStore.getState().backend).toBe('cloud')
    expect(useUIStore.getState().cloudGateOpen).toBe(false)
  })

  it('not signed in: the button opens the plans', () => {
    env.cardGb = 8
    show()
    fireEvent.click(cloud()!)
    expect(useUIStore.getState().cloudGateOpen).toBe(true)
    expect(useCreateStore.getState().backend).toBe('local')
  })

  it('ComfyUI on the processor, whatever the card', () => {
    env.cardGb = 24
    env.comfyOnCpu = true
    show()
    expect(line()?.textContent).toContain('ComfyUI runs on the processor here.')
  })

  it('cloud offers switched off: the line without the cloud', () => {
    env.cardGb = 8
    useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: false })
    show()
    expect(line()).not.toBeNull()
    expect(cloud()).toBeNull()
  })

  it('not for a card that fits, not on a Mac, not in the cloud, not in other tabs', () => {
    env.cardGb = 12
    show()
    expect(line()).toBeNull()
    cleanup()
    env.cardGb = 8
    env.mac = true
    show()
    expect(line()).toBeNull()
    cleanup()
    env.mac = false
    useCreateStore.setState({ backend: 'cloud' })
    show()
    expect(line()).toBeNull()
    cleanup()
    useCreateStore.setState({ backend: 'local' })
    show('image')
    expect(line()).toBeNull()
  })
})
