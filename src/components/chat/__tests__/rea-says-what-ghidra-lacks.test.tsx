/**
 * @vitest-environment jsdom
 *
 * B11: REA on Apple Silicon. The official Ghidra download carries its native
 * decompiler only for Windows and Linux x86-64; on a Mac every decompile ended
 * in `executable_missing … os/mac_arm_64/decompile`, and nothing in LU said
 * why. The row now names the Ghidra it found and, where the decompiler for
 * this machine is missing, the one build step Ghidra's own guide gives. And a
 * Ghidra LU found in a folder reaches REA, which a Finder start would not.
 *
 * Run: npx vitest run src/components/chat/__tests__/rea-says-what-ghidra-lacks.test.tsx
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { ReaPluginRow } from '../ReaPluginRow'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useReaRuntime } from '../../../lib/plugins/rea-runtime'
import { reaGhidraLine, reaServerConfig, type ReaGhidra, type ReaStatus } from '../../../lib/plugins/rea'

const macOhneDecompiler: ReaGhidra = {
  found: true,
  installDir: '/Users/x/ghidra_12.1.4_PUBLIC',
  foundBy: 'folder',
  version: '12.1.4',
  wantVersion: '12.1.4',
  nativeDir: 'mac_arm_64',
  decompiler: null,
  needsNatives: true,
  buildDir: '/Users/x/ghidra_12.1.4_PUBLIC/support/gradle',
}

const ready: ReaStatus = {
  version: '6.5.0', ready: true, tarball: '/d/rea.tgz', workDir: '/d/work', path: '/usr/bin',
  node: 'v24.11.0', nodeOk: true, nodeRange: 'x', ghidra: macOhneDecompiler,
}

beforeEach(() => {
  useSettingsStore.getState().updateSettings({ reaPluginEnabled: true })
  useReaRuntime.setState({ phase: 'off', tools: 0, error: null, ghidra: null })
})
afterEach(() => cleanup())

describe('what the REA row says about Ghidra', () => {
  it('a Ghidra without this Mac\'s decompiler gets the build step, in the row', () => {
    render(<ReaPluginRow />)
    act(() => { useReaRuntime.setState({ phase: 'on', tools: 207, ghidra: macOhneDecompiler }) })
    const line = screen.getByTestId('plugins-rea-ghidra').textContent ?? ''
    expect(line).toContain('no decompiler for this computer (mac_arm_64)')
    expect(line).toContain('cd "/Users/x/ghidra_12.1.4_PUBLIC/support/gradle" && gradle buildNatives')
    expect(line).toContain('xcode-select --install')
  })

  it('a ready one says so, and a wrong version is named', () => {
    const ok = { ...macOhneDecompiler, needsNatives: false, decompiler: '/x/decompile' }
    expect(reaGhidraLine(ok)).toMatch(/decompiler ready\.$/)
    expect(reaGhidraLine({ ...ok, version: '11.4' })).toContain('REA is made for Ghidra 12.1.4')
  })

  it('none found points at the official release, and an old Rust side says nothing', () => {
    expect(reaGhidraLine({ found: false, wantVersion: '12.1.4', nativeDir: 'mac_arm_64' })).toMatch(/Ghidra not found.*official GitHub release/)
    expect(reaGhidraLine(undefined)).toBeNull()
  })

  it('nothing about Ghidra before REA runs', () => {
    render(<ReaPluginRow />)
    act(() => { useReaRuntime.setState({ phase: 'starting', ghidra: macOhneDecompiler }) })
    expect(screen.queryByTestId('plugins-rea-ghidra')).toBeNull()
  })
})

describe('the Ghidra LU found reaches REA', () => {
  it('found in a folder: handed over as GHIDRA_INSTALL_DIR', () => {
    expect(reaServerConfig(ready).env?.GHIDRA_INSTALL_DIR).toBe('/Users/x/ghidra_12.1.4_PUBLIC')
  })

  it('found by the user\'s own variable or PATH: left to REA', () => {
    for (const foundBy of ['env', 'path'] as const) {
      const s = { ...ready, ghidra: { ...macOhneDecompiler, foundBy } }
      expect(reaServerConfig(s).env?.GHIDRA_INSTALL_DIR).toBeUndefined()
    }
  })
})
