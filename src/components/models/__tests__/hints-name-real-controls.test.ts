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
const chatInput = read('src/components/chat/ChatInput.tsx')
/** The effort button's OWN tooltip, pulled out of the shipped markup. */
const effortTip =
  chatInput.match(/const effortHint = [\s\S]{0,400}?: `([^`]*)`/)?.[1] ?? ''
/** And the one it shows while a local model still runs on its own default. */
const effortWaitTip = chatInput.match(/const effortHint = effortWaits\s*\? '([^']*)'/)?.[1] ?? ''
const remoteRs = read('src-tauri/src/commands/remote.rs')
// 01.09.2026 (T-75): the mobile drawer moved out of the Rust string it used to
// live in. The refusal text is still Rust; the controls it names are in the
// client source now.
const mobileClient = read('mobile-client/client.js')

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
    // the user on the tab that has no such control. Since round 9 it carries
    // the last step of the route too, the open ComfyUI section
    // (settings-deeplink-comfyui.test.ts holds that end of it).
    // The page names the button and where it goes; the face it wears
    // (skin/classic.tsx on Windows and Linux, skin/mac.tsx on the Mac) draws
    // it. Both halves are held: the route, and that each face wires the click
    // to exactly the action it was handed.
    expect(modelManager).toMatch(
      /label: 'Open Settings',\s*onClick: \(\) => openSettingsAt\(\{ tab: 'backends', section: 'comfyui' \}\)/,
    )
    for (const face of ['classic.tsx', 'mac.tsx']) {
      const src = read(`src/components/models/skin/${face}`)
      expect(src, face).toMatch(/onClick=\{action\.onClick\}[\s\S]{0,400}\{action\.label\}/)
    }
    expect(modelManager).not.toMatch(/Go to Create/)
  })
})

describe('the control the hint names is really there', () => {
  it('Settings has an AI Backends tab', () => {
    expect(settingsPage).toMatch(/id: 'backends',\s*label: 'AI Backends'/)
  })

  it('with a ComfyUI (Image & Video) section', () => {
    expect(settingsPage).toMatch(/<Section title="ComfyUI \(Image & Video\)"/)
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

  // 3.0.7: the refusal used to send the phone to its own Settings sheet, and
  // that sheet only reads the permissions (the server ignores a write from a
  // paired device). The switch is on the desktop.
  it('the remote permission refusal sends the user to the desktop switch', () => {
    expect(remoteRs).not.toMatch(/gear icon/)
    expect(remoteRs).not.toMatch(/turn it on under Remote Permissions/)
    expect(remoteRs).toMatch(
      /Turn it on in the LU desktop app under Settings, Voice & Remote, Remote Access, Permissions\./,
    )
  })

  it('and the desktop really spells it Voice & Remote, Remote Access, Permissions, with the switches there', () => {
    expect(settingsPage).toMatch(/label: 'Voice & Remote'/)
    expect(settingsPage).toMatch(/<Section title="Remote Access">\s*<RemoteAccessSettings \/>/)
    const remoteAccess = read('src/components/settings/RemoteAccessSettings.tsx')
    expect(remoteAccess).toMatch(/>Permissions<\/span>/)
    expect(remoteAccess).toMatch(/setPermissions\(\{ \.\.\.permissions, \[key\]: !permissions\[key\] \}\)/)
  })

  it('and the phone sheet only reads them, so pointing there was wrong', () => {
    expect(mobileClient).toMatch(/READS \/remote-api\/permissions; it cannot write/)
  })

  it('the LM Studio load error names the label the row shows, not an icon name', () => {
    expect(modelSelector).toMatch(/Try the On\/Off button on the model's row/)
    // Proof that On and Off are what that button actually renders.
    expect(modelSelector).toMatch(/loaded \? 'On' : 'Off'/)
  })
})

describe('the effort control in the composer says what it is and what it costs', () => {
  // New in 2.6.8, and it sits right beside the Think button, so it falls under
  // the same rule as everything above: a control's own text is a promise about
  // the screen and about the bill.

  it('the control is really there, with a stable handle for a counter-check', () => {
    expect(chatInput).toMatch(/data-testid="effort-toggle"/)
    expect(chatInput).toMatch(/<Gauge size=\{11\} \/>/)
  })

  it('its tooltip names the rung, the gesture and the price', () => {
    expect(chatInput).toMatch(
      /Reasoning effort: \$\{effortLabel\(effortNow\)\}\. Click to cycle\. Higher effort spends more output tokens\./,
    )
    expect(chatInput).toMatch(/title=\{effortHint\}/)
  })

  it('a local model nobody picked a rung for says Default, not a rung that is not sent', () => {
    expect(effortWaitTip).toBe(
      'Reasoning effort: Default, the model decides. Click to pick a level. Higher effort spends more output tokens.',
    )
    expect(chatInput).toMatch(/const effortText = effortWaits \? 'Default' : effortLabel\(effortNow\)/)
  })

  it('and "click to cycle" is what the button really does', () => {
    expect(chatInput).toMatch(/onClick=\{cycleEffort\}/)
    expect(chatInput).toMatch(/updateSettings\(\{ reasoningEffort: nextEffort\(effortLevels, effortNow\) \}\)/)
  })

  it('the label is the rung that actually goes on the wire, the clamped one', () => {
    // Showing Max while sending high would be a control that lies, on the one
    // axis where the user is paying attention because it costs money.
    expect(chatInput).toMatch(/const effortNow = clampEffort\(effortLevels, /)
    expect(chatInput).toMatch(/<span[^>]*>\{effortText\}<\/span>/)
  })

  it('it is drawn only where it is true: a declared ladder and thinking really on', () => {
    expect(chatInput).toMatch(/const showEffort = effortSteps\.length > 0 && thinkingIsOn/)
    expect(chatInput).toMatch(/const thinkingIsOn = thinkLockedOn \|\| \(thinkingEnabled && canThink\)/)
  })

  it('and it names no control that does not exist', () => {
    // No slider, no gear, no menu: it is one button that cycles, and the
    // tooltip says exactly that.
    expect(effortTip).toMatch(/Click to cycle/)
    expect(effortTip).not.toMatch(/slider|gear|drop-?down|menu|open settings/i)
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
