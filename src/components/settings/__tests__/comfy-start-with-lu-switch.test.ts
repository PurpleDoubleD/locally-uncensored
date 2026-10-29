/**
 * B12, box click-through 27.10.2026: LU started the user's own ComfyUI
 * (his own install in the home folder) at launch without asking. The boot path now only
 * connects (process.rs, comfy_boot_plan); starting with LU is a switch the
 * user sets, and the panel has to offer it and send what it saves.
 *
 * Run: npx vitest run src/components/settings/__tests__/comfy-start-with-lu-switch.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const lies = (...teile: string[]) => readFileSync(resolve(__dirname, '..', '..', '..', '..', ...teile), 'utf8')

describe('the switch for starting ComfyUI with LU', () => {
  it('the panel has it and saves through the command Rust registers', () => {
    const ui = lies('src', 'components', 'settings', 'SettingsPage.tsx')
    expect(ui).toContain('Start ComfyUI when LU starts')
    expect(ui).toMatch(/backendCall\('set_comfyui_autostart', \{ enabled \}\)/)
    expect(ui).toMatch(/checked=\{status\?\.autostart === true\}/)
    const lib = lies('src-tauri', 'src', 'lib.rs')
    expect(lib).toContain('commands::process::set_comfyui_autostart')
  })

  it('the status reports it, so the switch shows what is saved', () => {
    const rs = lies('src-tauri', 'src', 'commands', 'process.rs')
    expect(rs).toMatch(/"autostart": comfy_autostart_enabled\(\)/)
  })
})
