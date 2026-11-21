/**
 * The last Windows words on the Mac (persona walk of the Mac app,
 * 09.10.2026, Fund 24): the Run dialog and administrator windows in computer
 * control, "GPU layers" in the expert settings of the LU Engine, "no GPU
 * needed" in the Cloud panel and the chat model picker.
 *
 * Run: npx vitest run src/lib/__tests__/mac-pc-words.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  computerOffLimitsLine, gpuLayersLabel, gpuLayersTitle, gpuLayersHint,
  cloudGateHeadline, engineOffloadWords,
} from '../mac-pc-words'

const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf-8')
const PC_WORDS = /Run dialog|administrator rights|\bGPU\b|\bCPU\b|VRAM|KV cache/

describe('on the Mac', () => {
  const sentences = [
    computerOffLimitsLine(true), gpuLayersLabel(true), gpuLayersTitle(true), gpuLayersHint(true),
    cloudGateHeadline(true),
    engineOffloadWords('GPU layers: 18', true)!,
    engineOffloadWords('GPU layers: 0, the GPU start failed', true)!,
    engineOffloadWords('GPU layers: 0, the GPU answered unreadably', true)!,
  ]

  it('no sentence names what a Mac does not have', () => {
    for (const s of sentences) expect(s, s).not.toMatch(PC_WORDS)
  })

  it('no sentence carries a dash', () => {
    for (const s of sentences) expect(s, s).not.toMatch(/[\u2013\u2014]/)
  })

  it('computer control names what the macOS blocklist holds', () => {
    expect(computerOffLimitsLine(true)).toBe('Always off limits, and not a setting: LU itself, terminals and shells, password managers, sign-in and permission dialogs, Spotlight and other launchers, and System Settings.')
    const blocklist = readFileSync(resolve(__dirname, '../../../src-tauri/src/commands/computer/desk/blocklist.rs'), 'utf-8')
    for (const bundle of ['com.apple.Terminal', 'com.apple.SecurityAgent', 'com.apple.loginwindow', 'com.apple.Spotlight', 'com.apple.systempreferences']) {
      expect(blocklist, bundle).toContain(bundle)
    }
  })

  it('the engine row and its standing line use the same words', () => {
    expect(gpuLayersLabel(true)).toBe('Graphics layers')
    expect(engineOffloadWords('GPU layers: 18', true)).toBe('Graphics layers: 18')
    expect(engineOffloadWords('GPU layers: 0, the GPU start failed', true)).toBe('Graphics layers: 0, the graphics unit start failed')
    expect(engineOffloadWords(null, true)).toBeNull()
  })

  it('Cloud asks for no hardware the owner never chose', () => {
    expect(cloudGateHeadline(true)).toBe('Run uncensored models in the cloud, no powerful Mac needed.')
  })
})

describe('COUNTER-CHECK: Windows and Linux read every sentence as before', () => {
  it('letter for letter', () => {
    expect(computerOffLimitsLine(false)).toBe('Always off limits, and not a setting: LU itself, terminals and shells, password managers, sign-in and permission dialogs, the Run dialog and system launchers, security settings and windows with administrator rights.')
    expect(gpuLayersLabel(false)).toBe('GPU layers')
    // GH #156: -1 is auto on a PC, as many layers as fit, and says so.
    expect(gpuLayersTitle(false)).toBe('-1 = as many layers on the GPU as fit (default). 0 = CPU only. N = offload the first N layers, for when the model and its KV cache do not fit your VRAM.')
    expect(gpuLayersHint(false)).toBe('-1 = as many layers on GPU as fit · 0 = CPU only · N = partial offload for models bigger than your VRAM.')
    expect(cloudGateHeadline(false)).toBe('Run uncensored models in the cloud, no GPU needed.')
    expect(engineOffloadWords('GPU layers: 0, the GPU start failed', false)).toBe('GPU layers: 0, the GPU start failed')
  })
})

describe('the four surfaces', () => {
  it('take their sentence from here and keep no copy', () => {
    const uses: Array<[string, string, RegExp]> = [
      ['components/settings/PermissionSettings.tsx', '{computerOffLimitsLine(isMacOS())}', /the Run dialog/],
      ['components/settings/BuiltinEngineSettings.tsx', '{gpuLayersHint(isMacOS())}', /all layers on GPU/],
      ['components/settings/BuiltinEngineSettings.tsx', '{engineOffloadWords(engineOffloadLine(status), isMacOS())}', /offload every layer to the GPU/],
      ['components/cloud/CloudGateModal.tsx', '{cloudGateHeadline(isMacOS())}', /no GPU needed/],
    ]
    for (const [file, call, old] of uses) {
      const source = read(file)
      expect(source, file).toContain(call)
      expect(source, file).not.toMatch(old)
    }
  })
})
