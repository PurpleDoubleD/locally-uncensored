/**
 * @vitest-environment jsdom
 *
 * A5, GitHub #123 (Zhorts, 2026-09-01, Windows 11, RX 9070 XT, 64 GB RAM).
 *
 * The Model Manager fit check read "62 GB GPU · 62 GB RAM": the same number
 * twice, on a machine with a 16 GB card, while the Settings page one tab away
 * had the correct 16 GB. Two probes feed that chip and DiscoverModels keeps the
 * LARGER of the two, so one wrong number is enough to win.
 *
 * The wrong number came from ComfyUI. Without a usable GPU backend, and no ROCm
 * was detected on that box, ComfyUI still reports one device in /system_stats:
 * the CPU one, whose `vram_total` is `psutil.virtual_memory().total`. It is
 * system RAM in a field called vram_total, and `devices[0].vram_total` took it.
 *
 * The rule this file pins: system RAM never appears as VRAM, and where nothing
 * measured the GPU the answer is the word "unknown", not a number. A fit check
 * that admits it does not know is one a user can still act on. One that says
 * 62 GB sends him to download a model his card cannot hold.
 *
 * Run: npx vitest run src/api/__tests__/fit-check-never-shows-system-ram.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'

const localFetch = vi.fn()

vi.mock('../backend', () => ({
  localFetch: (...a: unknown[]) => localFetch(...a),
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  fetchLocalhostBytes: vi.fn(),
  isTauri: () => false,
  backendCall: vi.fn(),
  isMacOS: () => false,
}))

import { pickDeviceVramBytes } from '../comfyui'
import { HardwareChip } from '../../components/models/ModelTiles'
import { comfyErrorHint } from '../vram-handoff'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const GB = 1024 * 1024 * 1024

/** Zhorts' box: ComfyUI on the processor, so one device and it is the CPU. */
const CPU_ONLY = [
  { name: 'cpu', type: 'cpu', index: null, vram_total: 62 * GB, vram_free: 40 * GB, torch_vram_total: 0, torch_vram_free: 0 },
]

/** The same box once a ROCm build is in place. */
const HIP_CARD = [
  { name: 'cuda:0 AMD Radeon RX 9070 XT : hipMallocAsync', type: 'cuda', index: 0, vram_total: 16 * GB, vram_free: 15 * GB },
]

beforeEach(() => {
  localFetch.mockReset()
  cleanup()
})

describe('the CPU pseudo-device is not a graphics card', () => {
  it('drops a CPU-only device list instead of calling its RAM VRAM', () => {
    // NEGATIVE CONTROL, backwards: this is exactly what the old reader did, and
    // it is where the 62 came from.
    expect(Math.round((CPU_ONLY[0].vram_total as number) / GB)).toBe(62)
    expect(pickDeviceVramBytes(CPU_ONLY)).toBeNull()
  })

  it('still reports a real card', () => {
    expect(pickDeviceVramBytes(HIP_CARD)).toBe(16 * GB)
  })

  it('ignores the CPU entry sitting next to a card', () => {
    // ComfyUI lists both on some builds. The card decides, not whichever entry
    // the list happened to put first.
    expect(pickDeviceVramBytes([...CPU_ONLY, ...HIP_CARD])).toBe(16 * GB)
    expect(pickDeviceVramBytes([...HIP_CARD, ...CPU_ONLY])).toBe(16 * GB)
  })

  it('leaves Apple unified memory alone', () => {
    // On a Mac the mps device really does have the machine's memory as its
    // VRAM, so this one is a right answer and must survive.
    const mps = [{ name: 'mps', type: 'mps', index: 0, vram_total: 32 * GB }]
    expect(pickDeviceVramBytes(mps)).toBe(32 * GB)
  })

  it('answers null for every shape that says nothing', () => {
    // NEGATIVE CONTROLS: an unknown payload never turns into a number.
    expect(pickDeviceVramBytes([])).toBeNull()
    expect(pickDeviceVramBytes(undefined)).toBeNull()
    expect(pickDeviceVramBytes(null)).toBeNull()
    expect(pickDeviceVramBytes({ devices: HIP_CARD })).toBeNull()
    expect(pickDeviceVramBytes([{ name: 'cuda:0', type: 'cuda' }])).toBeNull()
    expect(pickDeviceVramBytes([{ name: 'cuda:0', type: 'cuda', vram_total: 0 }])).toBeNull()
    expect(pickDeviceVramBytes([{ name: 'cuda:0', type: 'cuda', vram_total: '16 GB' }])).toBeNull()
    expect(pickDeviceVramBytes([{ name: 'cuda:0', type: 'cuda', vram_total: Infinity }])).toBeNull()
  })

  it('recognises the CPU entry by either field', () => {
    // Older ComfyUI builds name the device without filling `type`.
    expect(pickDeviceVramBytes([{ name: 'cpu', vram_total: 62 * GB }])).toBeNull()
    expect(pickDeviceVramBytes([{ type: 'CPU', name: '', vram_total: 62 * GB }])).toBeNull()
    // NEGATIVE CONTROL: a card whose name merely starts with those letters is
    // not the CPU device. Nothing real is dropped by this rule.
    expect(pickDeviceVramBytes([{ name: 'cpuid test card', type: 'cuda', vram_total: 8 * GB }])).toBe(8 * GB)
  })
})

describe('a Mac shares one pool, so the CPU entry is the answer there', () => {
  // Review catch: detect_macos reports no size at all, so /system_stats is the
  // ONLY VRAM source on a Mac. ComfyUI started with --cpu reports a cpu device
  // there, and filtering it would have left every such Mac reading
  // "GPU unknown" and lost the "Fits my PC" filter with it.
  it('keeps the CPU device when the memory is unified', () => {
    expect(pickDeviceVramBytes(CPU_ONLY, { unifiedMemory: true })).toBe(62 * GB)
  })

  it('still prefers a real device over the shared pool', () => {
    const mps = [{ name: 'mps', type: 'mps', index: 0, vram_total: 96 * GB }]
    expect(pickDeviceVramBytes([...CPU_ONLY, ...mps], { unifiedMemory: true })).toBe(96 * GB)
  })

  it('does not soften the rule for anything else', () => {
    // NEGATIVE CONTROL: this is Zhorts' box, where the card has its own memory
    // and the CPU number is a different figure about a different thing. The
    // flag is off there and the 62 stays out.
    expect(pickDeviceVramBytes(CPU_ONLY)).toBeNull()
    expect(pickDeviceVramBytes(CPU_ONLY, {})).toBeNull()
    expect(pickDeviceVramBytes(CPU_ONLY, { unifiedMemory: false })).toBeNull()
  })
})

describe('the hardware chip', () => {
  it('says unknown for the side nothing measured', () => {
    render(createElement(HardwareChip, { vramGb: null, ramGb: 62 }))
    expect(screen.getByText('GPU unknown')).toBeTruthy()
    expect(screen.getByText('62 GB RAM')).toBeTruthy()
    // NEGATIVE CONTROL: the number that was wrong must not be anywhere near the
    // GPU half of the chip.
    expect(screen.queryByText('62 GB GPU')).toBeNull()
  })

  it('shows both numbers when both were measured', () => {
    render(createElement(HardwareChip, { vramGb: 16, ramGb: 62 }))
    expect(screen.getByText('16 GB GPU')).toBeTruthy()
    expect(screen.getByText('62 GB RAM')).toBeTruthy()
    expect(screen.queryByText('GPU unknown')).toBeNull()
  })

  it('stays away entirely when nothing at all is known', () => {
    const { container } = render(createElement(HardwareChip, { vramGb: null, ramGb: null }))
    expect(container.textContent).toBe('')
  })
})

describe('a healthy ROCm install is not painted as a fault', () => {
  // hypocritical_rj (help-chat "GPU Detection", 26.08.) opened a thread just to
  // ask whether the yellow line was a problem. Amber is the colour of "LU could
  // not confirm this", and a correct install has to stop wearing it.
  const settings = () => readFileSync(join(__dirname, '../../components/settings/HardwareSettings.tsx'), 'utf8')

  it('hangs the colour off the severity the backend sent', () => {
    expect(settings()).toMatch(/g\.note_severity === 'info' \? 'text-gray-500' : 'text-amber-500\/80'/)
  })

  it('leaves every older note in the warning colour', () => {
    // NEGATIVE CONTROL: the notes that predate the field carry no severity, and
    // they are all warnings, so an unknown severity must not fall to the muted
    // branch. The comparison is against 'info' for exactly that reason.
    expect(settings()).not.toMatch(/note_severity === 'warn'/)
    // And the unconditional amber that was here is gone.
    expect(settings()).not.toMatch(/className="text-\[0\.55rem\] text-amber-500\/80 mt-0\.5/)
  })
})

describe('hipErrorInvalidValue names the architecture instead of the error', () => {
  // A12, artoriuskurokami (Discord 2026-09-02, RX 9070 XT): image generation
  // dies with this, the same run on the processor completes.
  const RAW = "CUDA error: invalid argument\nSearch for 'hipErrorInvalidValue' in the ROCm documentation."

  it('names the detected target and the command that lists the build\'s', () => {
    const hint = comfyErrorHint('KSampler', 'RuntimeError', RAW, 'gfx1201')
    expect(hint).toContain('gfx1201')
    expect(hint).toContain('get_arch_list')
    // Rebuilding installs the same wheels, so the advice must not be that.
    expect(hint).not.toContain('Reinstall the ComfyUI environment')
  })

  it('points at the tool when no tool named the architecture', () => {
    const hint = comfyErrorHint('KSampler', 'RuntimeError', RAW, null)
    expect(hint).toContain('hipinfo')
    expect(hint).toContain('get_arch_list')
    // NEGATIVE CONTROL: nothing may be invented for the card. No gfx target and
    // no ROCm version appears when nothing on the machine reported one.
    expect(hint).not.toMatch(/gfx\d/)
    expect(hint).not.toMatch(/\b\d+\.\d+(\.\d+)?\b/)
  })

  it('leaves the other AMD failure to its own message', () => {
    // hipErrorNoBinaryForGPU is a different error with different advice and it
    // was here first. The new branch must not swallow it.
    const other = comfyErrorHint('KSampler', 'RuntimeError', 'hipErrorNoBinaryForGPU: Unable to find code object', 'gfx1030')
    expect(other).toContain('no compute kernels')
    expect(other).not.toContain('hipErrorInvalidValue')
  })

  it('is the only branch that needs the architecture at all', () => {
    // Review catch: the lookup used to run before every branch, so an
    // out-of-memory message waited on detect_gpus shelling out to the vendor
    // tools. The gate at the call site is the source of truth, so it is checked
    // here as source rather than guessed at.
    const call = readFileSync(join(__dirname, '../vram-handoff.ts'), 'utf8')
    expect(call).toMatch(/\/hiperrorinvalidvalue\/i\.test\(raw\) \? await getAmdGpuArch\(\)/)
    // NEGATIVE CONTROL: an unconditional await would put the probe in front of
    // every ComfyUI failure there is.
    expect(call).not.toMatch(/const arch = await getAmdGpuArch\(\)\.catch/)
  })

  it('says nothing about HIP for an error that is not about HIP', () => {
    // NEGATIVE CONTROL: a plain CUDA "invalid argument" on an NVIDIA box must
    // not be answered with AMD advice, so the match is on the HIP name alone.
    expect(comfyErrorHint('KSampler', 'RuntimeError', 'CUDA error: invalid argument', 'gfx1201')).toBe('')
  })
})
