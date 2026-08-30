/**
 * N1 of the R67 re-measure on the real 2.6.7 Windows build (2026-08-30,
 * ergebnis-r67-nachmessung.md).
 *
 * With ComfyUI down, the Model Manager sent the user to a control that does
 * not exist:
 *
 *   "Open the Create tab and start ComfyUI (the power button next to the
 *    model picker), then come back."
 *
 * The counter-check listed every visible button on Create: beside the model
 * picker sit "Workflows and tags", "Advanced settings" and "Create". No power
 * symbol anywhere, and Create itself said something else again ("Start it from
 * Settings"). The real control is Settings, AI Backends, ComfyUI (Image &
 * Video), Start.
 *
 * The sweep afterwards found two more of the same kind:
 *   - Hardware settings offered a "Power button (top-right)" for restarting
 *     Ollama and ComfyUI. There is no Power button in the header or the
 *     titlebar, and no restart control for Ollama at all.
 *   - The remote agent's permission refusal said "Open Settings (gear icon)".
 *     The mobile drawer's Settings button carries the `tune` sliders glyph,
 *     and the switches live under the label "Remote Permissions".
 *
 * A hint is a promise about the screen. These tests hold each text against the
 * source of the control it names, so a rename breaks the test instead of the
 * user's afternoon.
 *
 * Run: npx vitest run src/components/models/__tests__/hints-name-real-controls.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

const modelManager = read('src/components/models/ModelManager.tsx')
const settingsPage = read('src/components/settings/SettingsPage.tsx')
const hardware = read('src/components/settings/HardwareSettings.tsx')
const modelSelector = read('src/components/models/ModelSelector.tsx')
const remoteRs = read('src-tauri/src/commands/remote.rs')

describe('THE FIX: the ComfyUI-is-down hint names the control that exists', () => {
  it('it sends the user to Settings, AI Backends, Start', () => {
    expect(modelManager).toMatch(
      /Open Settings, go to AI Backends, and press Start under ComfyUI \(Image &amp; Video\)/,
    )
  })

  it('and no longer to the Create tab or to a power button', () => {
    expect(modelManager).not.toMatch(/power button/i)
    expect(modelManager).not.toMatch(/Open the Create tab and start ComfyUI/)
  })

  it('the button under the text goes where the text says', () => {
    // It used to read "Go to Create" and call setView('create'), which dropped
    // the user on the tab that has no such control.
    expect(modelManager).toMatch(/onClick=\{\(\) => setView\('settings'\)\}[\s\S]{0,400}Open Settings/)
    expect(modelManager).not.toMatch(/Go to Create/)
  })
})

describe('the control the hint names is really there', () => {
  it('Settings has an AI Backends tab', () => {
    expect(settingsPage).toMatch(/id: 'backends',\s*label: 'AI Backends'/)
  })

  it('with a ComfyUI (Image & Video) section', () => {
    expect(settingsPage).toMatch(/<Section title="ComfyUI \(Image & Video\)">/)
  })

  it('and a Start button in it that really starts ComfyUI', () => {
    expect(settingsPage).toMatch(/onClick=\{handleStart\}[\s\S]{0,300}>\s*Start\s*</)
    expect(settingsPage).toMatch(/const handleStart[\s\S]{0,600}backendCall\('start_comfyui'\)/)
  })
})

describe('the two the sweep turned up', () => {
  it('hardware settings no longer offers a Power button in a corner', () => {
    expect(hardware).not.toMatch(/Power button/)
    expect(hardware).not.toMatch(/top-right/)
  })

  it('it names the ComfyUI restart control instead, and LU itself for Ollama', () => {
    expect(hardware).toMatch(
      /Restart ComfyUI under AI Backends, ComfyUI \(Image &amp; Video\), or close LU to apply it to both/,
    )
    // The Restart button beside Start is the one meant here.
    expect(settingsPage).toMatch(/await handleStop\(\); setTimeout\(handleStart, 2000\)[\s\S]{0,300}Restart/)
  })

  it('the remote permission refusal drops the gear that is a sliders glyph', () => {
    expect(remoteRs).not.toMatch(/gear icon/)
    expect(remoteRs).toMatch(
      /Open the Menu, tap Settings, and turn it on under Remote Permissions\./,
    )
  })

  it('and the mobile drawer really spells it Menu, Settings, Remote Permissions', () => {
    expect(remoteRs).toMatch(/window\._toggleDrawer\(\)" aria-label="Menu"/)
    expect(remoteRs).toMatch(/window\._openSettingsSheet\(\)[\s\S]{0,200}svgIcon\('tune'\)\+'<\/span>Settings'/)
    expect(remoteRs).toMatch(/settings-section-label">Remote Permissions</)
  })

  it('the LM Studio load error names the label the row shows, not an icon name', () => {
    expect(modelSelector).toMatch(/Try the On\/Off button on the model's row/)
    // Proof that On and Off are what that button actually renders.
    expect(modelSelector).toMatch(/loaded \? 'On' : 'Off'/)
  })
})

describe('NEGATIVE CONTROL: no shipped text sends a user to a power button again', () => {
  const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', '.git'])

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (/\.(ts|tsx|rs)$/.test(entry) && !full.includes('__tests__')) out.push(full)
    }
    return out
  }

  const sources = [...walk(resolve(repo, 'src')), ...walk(resolve(repo, 'src-tauri/src'))]

  it('the sweep really looked at the whole app, not at three files', () => {
    expect(sources.length).toBeGreaterThan(200)
  })

  it('"power button" and "gear icon" appear nowhere', () => {
    const offenders = sources.filter((f) => /power button|gear icon/i.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('but the real Power controls are untouched, so this is a copy rule and not a purge', () => {
    // Two genuine Power glyphs stay: the per-model On/Off in the picker and the
    // MCP server enable toggle. A test that killed those would be a false pass.
    expect(modelSelector).toMatch(/<Power size=\{9\} \/>/)
    expect(read('src/components/settings/MCPServerSettings.tsx')).toMatch(/<Power size=\{12\} \/>/)
  })
})
