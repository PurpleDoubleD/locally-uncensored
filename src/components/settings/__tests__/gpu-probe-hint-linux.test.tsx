/**
 * @vitest-environment jsdom
 *
 * C74 (3.1.0): Linux without lspci (Distrobox, Toolbox, minimal systems).
 * c1rrus (Bazzite, RX 6900 XT) saw an empty card list and ComfyUI silently
 * got the processor build of PyTorch. The backend now falls back to sysfs and,
 * when even that finds nothing, `gpu_probe_hint` names the missing tool.
 *
 * Negative control: drop the `gpu_probe_hint` call in HardwareSettings and the
 * first case turns red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

let gpus: unknown[] = []
let hint: string | null = null
const calls: string[] = []
vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  isTauri: () => true,
  isMacOS: () => false,
  backendCall: vi.fn(async (cmd: string) => {
    calls.push(cmd)
    if (cmd === 'detect_gpus') return gpus
    if (cmd === 'gpu_probe_hint') return hint
    return null
  }),
}))
vi.mock('../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))

const { HardwareSettings } = await import('../HardwareSettings')

const HINT = 'No graphics card found, and the lspci tool is missing on this system. Install pciutils.'

beforeEach(() => {
  calls.length = 0
  gpus = []
  hint = null
})
afterEach(cleanup)

describe('C74: an empty card list says why when lspci is missing', () => {
  it('shows the backend hint under an empty list', async () => {
    hint = HINT
    render(<HardwareSettings />)
    const el = await screen.findByTestId('gpu-probe-hint')
    expect(el.textContent).toBe(HINT)
  })

  it('says nothing extra when the backend has no hint (a machine without a card)', async () => {
    render(<HardwareSettings />)
    await waitFor(() => expect(calls).toContain('gpu_probe_hint'))
    expect(screen.queryByTestId('gpu-probe-hint')).toBeNull()
  })

  it('does not ask for a hint when cards were found, e.g. from sysfs', async () => {
    gpus = [{ index: 0, vendor: 'amd', name: 'Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]', memory_mib: 16368, source: 'sysfs', note: 'Listed from the kernel (/sys/class/drm) because lspci is not installed.' }]
    hint = HINT
    render(<HardwareSettings />)
    await screen.findByText(/Navi 21/)
    expect(calls).not.toContain('gpu_probe_hint')
    expect(screen.queryByTestId('gpu-probe-hint')).toBeNull()
  })
})
