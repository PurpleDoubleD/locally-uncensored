/**
 * @vitest-environment jsdom
 *
 * C56 (3.1.0, the_cave_dweller on Discord: RTX 4090 + RTX 5080, 64 GB RAM):
 * Settings, Hardware offers "One big model across two cards" next to "Card
 * per task". Simulated cards, no real two-card machine. The 5080 is listed
 * first on purpose (bus order), so the default has to pick the bigger card
 * for the model, not the first one.
 *
 * Negative controls: one card shows nothing; an NVIDIA card next to an AMD
 * one gets "Card per task" but no split (the split is NVIDIA only); turning
 * it off leaves exactly the roles of 3.0.8.
 *
 * Run: npx vitest run src/components/settings/__tests__/ein-modell-ueber-zwei-karten.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const calls: Array<{ cmd: string; args?: unknown }> = []
let cards: unknown[] = []
vi.mock('../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/backend')>()),
  isTauri: () => true,
  isMacOS: () => false,
  backendCall: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args })
    if (cmd === 'detect_gpus') return cards
    if (cmd === 'describe_gpu_roles') {
      return [{
        service: 'ComfyUI',
        env: ['CUDA_DEVICE_ORDER=PCI_BUS_ID', 'CUDA_VISIBLE_DEVICES=GPU-4090,GPU-5080'],
        args: [],
        note: 'One model across two cards: the diffusion model on #1 NVIDIA GeForce RTX 4090, text encoders and VAE on #0 NVIDIA GeForce RTX 5080 (ComfyUI calls it gpu:1).',
      }]
    }
    return null
  }),
}))
vi.mock('../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../../../api/comfy-restart', () => ({ restartComfyForNewNodes: async () => {} }))

const { HardwareSettings } = await import('../HardwareSettings')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { DEFAULT_SETTINGS } = await import('../../../lib/constants')

const R5080 = { index: 0, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5080', memory_mib: 16303, source: 'nvidia-smi' }
const R4090 = { index: 1, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', memory_mib: 24564, source: 'nvidia-smi' }
const ref = (c: typeof R4090) => ({ vendor: 'nvidia', index: c.index, name: c.name })

const lastRoles = () => [...calls].reverse().find((c) => c.cmd === 'set_gpu_roles')?.args as { roles: unknown } | undefined
const TOGGLE = 'One big model across two cards'

beforeEach(() => {
  calls.length = 0
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...DEFAULT_SETTINGS } }))
})
afterEach(() => cleanup())

describe('one big model across two cards', () => {
  it('4090 + 5080: on, the model goes to the 4090, text encoder and VAE to the 5080, Rust gets it', async () => {
    cards = [R5080, R4090]
    render(<HardwareSettings />)
    fireEvent.click(await screen.findByLabelText(TOGGLE))
    const want = { chat: null, comfy: null, comfySplit: { model: ref(R4090), helper: ref(R5080) } }
    expect(useSettingsStore.getState().settings.gpuRoles).toEqual(want)
    await waitFor(() => expect(lastRoles()?.roles).toEqual(want))
    expect((screen.getByLabelText('Model on') as HTMLSelectElement).value).toBe('nvidia:1')
    expect((screen.getByLabelText('Text encoder and VAE on') as HTMLSelectElement).value).toBe('nvidia:0')
    // ComfyUI's single card waits while the split is on.
    expect((screen.getByLabelText('Pictures and video (ComfyUI)') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByTestId('gpu-roles-restart-hint')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('gpu-roles-plan').textContent).toContain('CUDA_VISIBLE_DEVICES=GPU-4090,GPU-5080'))
  })

  it('picking the other card for the model swaps the two', async () => {
    cards = [R5080, R4090]
    render(<HardwareSettings />)
    fireEvent.click(await screen.findByLabelText(TOGGLE))
    fireEvent.change(screen.getByLabelText('Model on'), { target: { value: 'nvidia:0' } })
    expect(useSettingsStore.getState().settings.gpuRoles.comfySplit).toEqual({ model: ref(R5080), helper: ref(R4090) })
  })

  it('a picked ComfyUI card becomes the model card', async () => {
    cards = [R5080, R4090]
    useSettingsStore.getState().updateSettings({ gpuRoles: { chat: null, comfy: ref(R5080) as never } })
    render(<HardwareSettings />)
    fireEvent.click(await screen.findByLabelText(TOGGLE))
    expect(useSettingsStore.getState().settings.gpuRoles.comfySplit).toEqual({ model: ref(R5080), helper: ref(R4090) })
  })

  it('the chat on one of the two cards says it still makes room', async () => {
    cards = [R5080, R4090]
    render(<HardwareSettings />)
    fireEvent.click(await screen.findByLabelText(TOGGLE))
    fireEvent.change(screen.getByLabelText('Chat (LU Engine, Ollama)'), { target: { value: 'nvidia:0' } })
    expect(screen.getByText(/still has to make room/)).toBeTruthy()
    expect(screen.queryByText(/no longer takes the chat model off its card/)).toBeNull()
  })

  it('off again: exactly the roles of 3.0.8, no split key left', async () => {
    cards = [R5080, R4090]
    render(<HardwareSettings />)
    fireEvent.click(await screen.findByLabelText(TOGGLE))
    fireEvent.click(screen.getByLabelText(TOGGLE))
    expect(useSettingsStore.getState().settings.gpuRoles).toEqual({ chat: null, comfy: null })
    expect((screen.getByLabelText('Pictures and video (ComfyUI)') as HTMLSelectElement).disabled).toBe(false)
  })

  it('NEGATIVE: one card, no toggle', async () => {
    cards = [R4090]
    render(<HardwareSettings />)
    await waitFor(() => expect(calls.some((c) => c.cmd === 'detect_gpus')).toBe(true))
    await screen.findAllByText(/RTX 4090/)
    expect(screen.queryByLabelText(TOGGLE)).toBeNull()
    expect(screen.queryByTestId('comfy-split')).toBeNull()
  })

  it('NEGATIVE: NVIDIA + AMD, Card per task yes, the split no', async () => {
    cards = [R4090, { index: 0, vendor: 'amd', name: 'AMD Radeon RX 7900 XTX', memory_mib: 24560, source: 'rocm-smi' }]
    render(<HardwareSettings />)
    await screen.findByLabelText('Chat (LU Engine, Ollama)')
    expect(screen.queryByLabelText(TOGGLE)).toBeNull()
  })
})
