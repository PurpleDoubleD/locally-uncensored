/**
 * @vitest-environment jsdom
 *
 * Settings, Hardware on a Mac is a readout, not a GPU picker.
 *
 * Fehlerkontrolle Mac 2, Fund 4: the section offered NVIDIA / AMD / Intel and
 * the CUDA, HIP and ONEAPI variables with the Apple chip listed as a "GPU".
 * None of it does anything on Apple Silicon. A Mac now reads its chip, its
 * shared memory and Metal, and gets no control. Windows and Linux keep the
 * picker under its old title.
 *
 * Negative control: rendering HardwareSettings in place of AppleHardwareInfo
 * turns the "no control" case red (four radios), and with the rail entry as
 * it was (`...(flags.gpuPicker ? [...] : [])`) the Mac has no Hardware
 * section at all.
 *
 * Run: npx vitest run src/components/settings/__tests__/mac-hardware-is-a-readout.test.tsx
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const backendCall = vi.hoisted(() => vi.fn())
vi.mock('../../../api/backend', () => ({
  backendCall: (cmd: string, args?: unknown) => backendCall(cmd, args),
  isTauri: () => true,
  isMacOS: () => true,
}))

import { AppleHardwareInfo, readAppleHardware } from '../AppleHardwareInfo'
import { sectionsFor, type SettingsSectionFlags } from '../settings-nav'

const GB = 1_073_741_824

/** A Mac as the app sees it: what detect_gpus and system_info answer. */
function mac(opts: { chip?: string; sharedMib?: number | null; ramGb?: number }) {
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'detect_gpus') {
      return opts.chip === undefined
        ? []
        : [{ index: 0, vendor: 'apple', name: opts.chip, memory_mib: null, shared_memory_mib: opts.sharedMib ?? null, source: 'system' }]
    }
    if (cmd === 'system_info') return { totalMemory: (opts.ramGb ?? 0) * GB }
    throw new Error(`unexpected command ${cmd}`)
  })
}

afterEach(() => { cleanup(); backendCall.mockReset() })

describe('what a Mac reads under Hardware', () => {
  it('chip, shared memory and Metal', async () => {
    mac({ chip: 'Apple M2 Pro', sharedMib: 16 * 1024 })
    render(<AppleHardwareInfo />)
    await waitFor(() => expect(screen.getByTestId('apple-hardware-chip').textContent).toBe('Apple M2 Pro'))
    expect(screen.getByTestId('apple-hardware-memory').textContent).toBe('16 GB, shared by processor and graphics')
    expect(screen.getByTestId('apple-hardware-graphics').textContent).toBe('Metal')
  })

  it('no control at all: nothing to pick, nothing to save', async () => {
    mac({ chip: 'Apple M4 Max', ramGb: 64 })
    const { container } = render(<AppleHardwareInfo />)
    await waitFor(() => expect(screen.getByTestId('apple-hardware-memory').textContent).toContain('64 GB'))
    expect(container.querySelectorAll('input, select, button')).toHaveLength(0)
    expect(backendCall.mock.calls.map((c) => c[0])).not.toContain('set_gpu_selection')
  })

  it('no PC vocabulary: no vendor, no CUDA, no VRAM, and the chip is not called a GPU', async () => {
    mac({ chip: 'Apple M2 Pro', ramGb: 16 })
    const { container } = render(<AppleHardwareInfo />)
    await waitFor(() => expect(screen.getByTestId('apple-hardware-chip').textContent).toBe('Apple M2 Pro'))
    expect(container.textContent).not.toMatch(/NVIDIA|AMD|Intel|CUDA|HIP_|ONEAPI|VRAM|GPU|ComfyUI|Ollama/)
  })
})

describe('where the memory comes from', () => {
  it('shared_memory_mib on the Apple entry, the probe\'s own word for the pool', async () => {
    mac({ chip: 'Apple M3', sharedMib: 24 * 1024, ramGb: 0 })
    expect(await readAppleHardware()).toEqual({ chip: 'Apple M3', memoryGb: 24 })
  })

  it('system_info when the entry carries no pool (a build before the field)', async () => {
    mac({ chip: 'Apple M1', sharedMib: null, ramGb: 8 })
    expect(await readAppleHardware()).toEqual({ chip: 'Apple M1', memoryGb: 8 })
  })

  it('both: the probe wins, and it is one number, not a sum', async () => {
    mac({ chip: 'Apple M3', sharedMib: 24 * 1024, ramGb: 23.6 })
    expect(await readAppleHardware()).toEqual({ chip: 'Apple M3', memoryGb: 24 })
  })

  it('neither: unknown is shown as unknown, never as 0 GB', async () => {
    mac({ ramGb: 0 })
    render(<AppleHardwareInfo />)
    await waitFor(() => expect(screen.getByTestId('apple-hardware-memory').textContent).toBe('Not detected'))
    expect(screen.getByTestId('apple-hardware-chip').textContent).toBe('Apple Silicon')
  })

  it('a failing probe does not take the section down', async () => {
    backendCall.mockRejectedValue(new Error('no backend'))
    render(<AppleHardwareInfo />)
    await waitFor(() => expect(screen.getByTestId('apple-hardware-memory').textContent).toBe('Not detected'))
  })
})

describe('the section in Settings', () => {
  const flags = (gpuPicker: boolean): SettingsSectionFlags => ({
    gpuPicker, builtinExpert: false, comfyui: gpuPicker, agentMode: true, agentWorkflows: true, mediaTimeouts: gpuPicker, chatTimeout: true, watchers: true,
  })

  it('a Mac has a Hardware section, and it is not called a GPU picker', () => {
    const sections = sectionsFor('general', flags(false))
    expect(sections).toContain('Hardware')
    expect(sections).not.toContain('Hardware (GPU picker)')
  })

  it('WINDOWS CONTROL: the picker keeps its title and its place', () => {
    const sections = sectionsFor('general', flags(true))
    expect(sections).toContain('Hardware (GPU picker)')
    expect(sections).not.toContain('Hardware')
    expect(sections.indexOf('Hardware (GPU picker)')).toBe(sections.indexOf('Generation') + 1)
  })

  it('the page renders the picker off the Mac and the readout on it, never both', () => {
    const src = readFileSync(resolve(__dirname, '..', 'SettingsPage.tsx'), 'utf8')
    const at = src.indexOf('<Section title="Hardware (GPU picker)">')
    const block = src.slice(src.lastIndexOf('{!isMlxImageHost() ? (', at), src.indexOf('<AppleHardwareInfo />', at) + 60)
    expect(block).toMatch(/\{!isMlxImageHost\(\) \? \(\s*<Section title="Hardware \(GPU picker\)">\s*<HardwareSettings \/>\s*<\/Section>\s*\) : \(\s*<Section title="Hardware">\s*<AppleHardwareInfo \/>/)
  })

  it('WINDOWS CONTROL: the picker itself is untouched', () => {
    const src = readFileSync(resolve(__dirname, '..', 'HardwareSettings.tsx'), 'utf8')
    expect(src).toContain("nvidia: 'NVIDIA (CUDA_VISIBLE_DEVICES)'")
    expect(src).toContain('GPU picker. Forwards CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES / ONEAPI_DEVICE_SELECTOR to Ollama + ComfyUI on next spawn.')
    expect(src).not.toMatch(/isMacOS|AppleHardware/)
  })
})
