/**
 * The page a paired phone receives — checked against the files it is made of.
 *
 * ── 01.09.2026 (T-75) ──
 *
 * This file used to pull the page out of a Rust string:
 *
 *     src.match(/async fn mobile_landing\(\)[\s\S]*?Html\(r#"([\s\S]*?)"#…/)
 *
 * One regex against 7 483 lines of Rust, and then thirty `toContain` calls
 * against the 182 KB blob it returned. Two things were wrong with that. The
 * regex was load-bearing and undeclared: reformat `mobile_landing` and every
 * assertion below stops running, silently, because the match still succeeded
 * on something. And a blob has no structure, so `expect(html).toContain(
 * '.drawer{')` could not tell a stylesheet rule from the same characters in a
 * comment or a JavaScript string.
 *
 * The client is real source now, so each assertion reads the file it is
 * actually about: markup from index.html, rules from styles.css, behaviour
 * from client.js — and the constants are imported, not matched.
 *
 * What Rust still owns is that these files really are what gets served:
 * `mobile_source_of_truth_tests::mobile_landing_is_what_the_sources_say` in
 * src-tauri/src/commands/remote.rs re-assembles the page on every `cargo test`
 * and compares it byte for byte with the embedded one.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CAVEMAN_PROMPTS, CAVEMAN_REMINDERS } from '../../../mobile-client/caveman.js'
import { CODEX_PROMPT, PERSONAS, THINKING_COMPATIBLE } from '../../../mobile-client/personas.js'

const read = (name: string) =>
  readFileSync(resolve(__dirname, '..', '..', '..', 'mobile-client', name), 'utf8')

/** The document shell: everything outside <style> and <script>. */
const HTML = read('index.html')
/** The stylesheet, on its own, so a rule assertion cannot match a comment. */
const CSS = read('styles.css')
/** The client script's shell — the part that touches the DOM. */
const JS = read('client.js')

describe('mobile page › the shell is a whole HTML document', () => {
  it('starts as a document and names the two splice points', () => {
    expect(HTML.startsWith('<!DOCTYPE html>')).toBe(true)
    // The assembler fills these in; a shell that lost one would ship a page
    // with no stylesheet or no script, and src-tauri/build.rs stops the build
    // over exactly that.
    expect(HTML).toContain('/*@@LU_STYLES@@*/')
    expect(HTML).toContain('//@@LU_SCRIPT@@')
  })

  it('contains <html>, <head>, <body>, </html>', () => {
    expect(HTML).toContain('<html')
    expect(HTML).toContain('<head>')
    expect(HTML).toContain('<body>')
    expect(HTML).toContain('</html>')
  })

  it('includes mobile viewport meta', () => {
    expect(HTML).toMatch(/<meta name="viewport"[^>]+width=device-width/)
  })

  it('sets a restrictive Content-Security-Policy (Bug #6)', () => {
    expect(HTML).toContain('http-equiv="Content-Security-Policy"')
    expect(HTML).toContain("default-src 'self'")
    expect(HTML).toContain("frame-ancestors 'none'")
  })

  it('has black theme color for mobile chrome', () => {
    expect(HTML).toContain("content='#0e0e0e'")
  })

  it('keeps the browser tab discreet (D#101)', () => {
    // The tab title and the saved-to-homescreen name are what bystanders see;
    // both stay a neutral "AI Terminal".
    expect(HTML).toContain('<title>AI Terminal</title>')
    expect(HTML).toContain('name="apple-mobile-web-app-title" content="AI Terminal"')
    expect(HTML).not.toContain('<title>LU</title>')
    expect(HTML).not.toContain('LUncensored')
    expect(HTML).not.toContain('Locally Uncensored')
  })
})

describe('mobile page › no third-party requests (Bug #5)', () => {
  it('the stylesheet uses the system font stack and loads no font', () => {
    expect(CSS).toContain('system-ui')
    expect(CSS).not.toContain('fonts.googleapis.com')
    expect(CSS).not.toContain('fonts.gstatic.com')
    expect(CSS).not.toContain('Material+Symbols+Outlined')
    expect(CSS).not.toContain('@import')
  })

  it('no file in the client reaches a third-party host', () => {
    for (const [name, src] of [
      ['index.html', HTML],
      ['styles.css', CSS],
      ['client.js', JS],
    ] as const) {
      // Data and blob URLs are fine — thumbnails and the QR code use them.
      const external = src.match(/https?:\/\/[^\s"'()]+/g) ?? []
      expect(external, `${name} names an external host`).toEqual([])
    }
  })

  it('icons are inline SVG, dispatched by name', () => {
    expect(JS).toContain('function svgIcon(')
    expect(JS).toContain('var ICONS =')
  })
})

describe('mobile page › LU branding assets', () => {
  it('references the white-transparent monogram path', () => {
    expect(JS).toContain('/LU-monogram-white.png')
  })

  it('does NOT reference the old bw monogram (should have been migrated)', () => {
    expect(JS).not.toContain('/LU-monogram-bw.png')
    expect(HTML).not.toContain('/LU-monogram-bw.png')
  })

  it('uses the monogram in at least 4 places (auth, header, drawer, welcome)', () => {
    const matches = JS.match(/\/LU-monogram-white\.png/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(4)
  })

  it('the in-page wordmark is LU', () => {
    expect(JS).toContain('class="auth-logo">LU<')
  })
})

describe('mobile page › feature markers', () => {
  it('hamburger drawer rules live in the stylesheet', () => {
    expect(CSS).toContain('.drawer{')
    expect(CSS).toContain('.drawer-backdrop')
  })

  it('has _toggleDrawer handler', () => {
    expect(JS).toContain('_toggleDrawer')
  })

  it('has _newChat handler for Chat + Codex', () => {
    expect(JS).toContain('_newChat')
    expect(JS).toContain("'codex'")
    expect(JS).toContain("'lu'")
  })

  it('exposes _openModelPicker and _openPluginsPicker', () => {
    expect(JS).toContain('_openModelPicker')
    expect(JS).toContain('_openPluginsPicker')
  })

  it('has _toggleThinking handler', () => {
    expect(JS).toContain('_toggleThinking')
  })

  it('has _triggerAttach + _removeImage for file attach', () => {
    expect(JS).toContain('_triggerAttach')
    expect(JS).toContain('_removeImage')
  })

  it('file input accepts image/* and multiple files', () => {
    expect(JS).toMatch(/file-input[^>]*accept="image\/\*"[^>]*multiple/)
  })

  it('has _setCaveman + _setPersona handlers', () => {
    expect(JS).toContain('_setCaveman')
    expect(JS).toContain('_setPersona')
  })

  it('has _loadChat and _deleteChat handlers', () => {
    expect(JS).toContain('_loadChat')
    expect(JS).toContain('_deleteChat')
  })

  it('has _disconnect handler', () => {
    expect(JS).toContain('_disconnect')
  })
})

describe('mobile page › caveman / persona / codex content', () => {
  // Imported, not matched: these are the objects the client really reads.
  it('ships exactly three caveman levels, each with a reminder', () => {
    expect(Object.keys(CAVEMAN_PROMPTS)).toEqual(['lite', 'full', 'ultra'])
    expect(Object.keys(CAVEMAN_REMINDERS).sort()).toEqual(['full', 'lite', 'ultra'])
  })

  it('every caveman prompt says the code stays untouched', () => {
    for (const level of Object.keys(CAVEMAN_PROMPTS) as (keyof typeof CAVEMAN_PROMPTS)[]) {
      expect(CAVEMAN_PROMPTS[level].toLowerCase()).toMatch(/code|unchanged/)
    }
  })

  it('the reminders are short bracketed nudges, not second prompts', () => {
    for (const level of Object.keys(CAVEMAN_REMINDERS) as (keyof typeof CAVEMAN_REMINDERS)[]) {
      expect(CAVEMAN_REMINDERS[level]).toMatch(/^\[.+\]$/)
      expect(CAVEMAN_REMINDERS[level].length).toBeLessThan(40)
    }
  })

  it('the codex prompt introduces the Coding Agent and forbids guessing', () => {
    expect(CODEX_PROMPT).toContain('You are the Coding Agent')
    expect(CODEX_PROMPT).toContain('never guess file contents')
  })

  it('No Filter is the default persona and carries no prompt', () => {
    expect(PERSONAS[0].id).toBe('unrestricted')
    expect(PERSONAS[0].name).toBe('No Filter')
    expect(PERSONAS[0].prompt).toBe('')
  })

  it('ships Code Expert', () => {
    const coder = PERSONAS.find((p) => p.id === 'coder')
    expect(coder?.name).toBe('Code Expert')
    expect(coder?.prompt.length).toBeGreaterThan(20)
  })

  it('ships at least 20 personas, each with a unique id', () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length)
    for (const p of PERSONAS) {
      expect(typeof p.name).toBe('string')
      expect(typeof p.prompt).toBe('string')
    }
  })

  it('THINKING_COMPATIBLE lists the desktop families', () => {
    for (const tag of ['qwq', 'deepseek-r1', 'qwen3', 'gemma3', 'gemma4']) {
      expect(THINKING_COMPATIBLE).toContain(tag)
    }
  })
})

describe('mobile page › input bar sizing parity', () => {
  it('textarea min-height 44px matches attach/send button height', () => {
    expect(CSS).toMatch(/min-height:44px/)
  })

  it('attach + send buttons are 44x44', () => {
    expect(CSS).toMatch(/\.attach-btn,\.send-btn\{width:44px;height:44px/)
  })
})

describe('mobile page › plugins picker structure', () => {
  it('plugin sub-folder rows are collapsed by default via pluginsOpen reset', () => {
    expect(JS).toMatch(/pluginsOpen\s*=\s*\{caveman:false,\s*persona:false\}/)
  })

  it('persona has on/off switch element', () => {
    expect(JS).toContain('data-persona-enabled')
    expect(JS).toContain('plug-switch')
  })

  it('picker sheet has a Plugins title', () => {
    expect(JS).toContain('>Plugins<')
  })
})

describe('mobile page › security/UX details', () => {
  it('auth screen uses numeric input for passcode', () => {
    expect(JS).toMatch(/inputmode="numeric"/)
    expect(JS).toMatch(/maxlength="6"/)
  })

  it('401 handler clears token + reloads', () => {
    expect(JS).toContain('clearAuthAndReload')
  })

  it('Bearer token attached to authenticated fetches', () => {
    expect(JS).toContain("'Authorization':'Bearer '+TOKEN")
  })

  it('chat-event endpoint posts mirror to desktop', () => {
    expect(JS).toContain('/remote-api/chat-event')
  })

  it('streaming chat endpoint is /api/chat (Ollama proxy)', () => {
    expect(JS).toContain("fetch('/api/chat'")
  })
})
