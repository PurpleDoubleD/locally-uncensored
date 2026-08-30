import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  comfyIdleNotice,
  shouldWatchComfyIdle,
  IDLE_WATCH_INTERVAL_MS,
  IDLE_STOPPED_MANAGED,
  IDLE_STOPPED_REMOTE,
  IDLE_STOPPED_UNUSABLE,
  IDLE_STARTING,
} from '../comfy-idle-watch'

const MANAGED_UP = { running: true, starting: false, isLocal: true, found: true, complete: true }
const MANAGED_DOWN = { running: false, starting: false, isLocal: true, found: true, complete: true }
const REMOTE_DOWN = { running: false, starting: false, isLocal: false, found: false, complete: false }
const CARCASS_DOWN = { running: false, starting: false, isLocal: true, found: true, complete: false }

describe('shouldWatchComfyIdle', () => {
  it('watches while the local Create tab sits idle', () => {
    expect(shouldWatchComfyIdle(true, false, false)).toBe(true)
  })

  it('does not watch on cloud, on a Mac, or during a render', () => {
    expect(shouldWatchComfyIdle(false, false, false)).toBe(false)
    expect(shouldWatchComfyIdle(true, true, false)).toBe(false)
    expect(shouldWatchComfyIdle(true, false, true)).toBe(false)
  })

  it('asks rarely enough not to be a poller on port 8188', () => {
    expect(IDLE_WATCH_INTERVAL_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('comfyIdleNotice', () => {
  /**
   * DER BEFUND SELBST (R18 Befund 2, Windows box): ComfyUI stirbt im Leerlauf,
   * der Create-Tab schweigt 180 Sekunden.
   *
   * Rueckwaerts gefahrene Negativkontrolle: der Zustand VOR dieser Runde ist
   * genau "es gibt keinen Satz", also der leere String. Der Test haelt fest,
   * dass die tote, verwaltete Engine jetzt einen Satz hat und dass dieser Satz
   * sagt, was als naechstes passiert.
   */
  it('THE FINDING: a managed ComfyUI that died idle gets a sentence, not silence', () => {
    const said = comfyIdleNotice(MANAGED_DOWN)
    expect(said).not.toBe('')
    expect(said).toBe(IDLE_STOPPED_MANAGED)
    expect(said).toMatch(/next render/)
  })

  it('says nothing while ComfyUI is answering', () => {
    expect(comfyIdleNotice(MANAGED_UP)).toBe('')
  })

  it('says nothing about a state it does not know', () => {
    expect(comfyIdleNotice(null)).toBe('')
  })

  it('names a start in progress instead of crying outage', () => {
    expect(comfyIdleNotice({ ...MANAGED_DOWN, starting: true })).toBe(IDLE_STARTING)
  })

  it('never promises a restart LU cannot deliver', () => {
    expect(comfyIdleNotice(REMOTE_DOWN)).toBe(IDLE_STOPPED_REMOTE)
    expect(comfyIdleNotice(REMOTE_DOWN)).not.toMatch(/next render/)
    expect(comfyIdleNotice(CARCASS_DOWN)).toBe(IDLE_STOPPED_UNUSABLE)
    expect(comfyIdleNotice(CARCASS_DOWN)).not.toMatch(/next render/)
  })

  it('keeps every line in English, per the house rule', () => {
    for (const line of [IDLE_STOPPED_MANAGED, IDLE_STOPPED_REMOTE, IDLE_STOPPED_UNUSABLE, IDLE_STARTING]) {
      expect(line).not.toMatch(/[äöüßÄÖÜ]/)
      expect(line).not.toMatch(/—|–/)
    }
  })
})

describe('the Create tab actually watches and shows it', () => {
  const src = readFileSync(
    join(__dirname, '../../components/create/experimental/CreateExperimental.tsx'),
    'utf-8',
  )

  it('polls comfyui_status only while idle, and renders the line', () => {
    expect(src).toMatch(/shouldWatchComfyIdle\(backend === 'local', isMacOS\(\), isGenerating\)/)
    expect(src).toMatch(/backendCall<ComfyGuardStatus>\('comfyui_status'\)/)
    expect(src).toMatch(/setIdleNotice\(comfyIdleNotice\(st\)\)/)
    expect(src).toMatch(/\{idleNotice && \(/)
  })

  it('starts nothing on its own from the idle watch', () => {
    const watch = src.slice(src.indexOf('R18 Befund 2'), src.indexOf('const fixCorsForMe'))
    expect(watch).not.toMatch(/start_comfyui|ensureComfyForRender|restartComfy/)
  })

  it('clears the interval when the tab goes away', () => {
    expect(src).toMatch(/idleTimerRef\.current\?\.\(\)/)
  })
})
