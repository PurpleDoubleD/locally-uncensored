import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  comfyCorsSignature,
  shouldShowCorsNotice,
  loadComfyCorsSignature,
  UNKNOWN_COMFY_VERSION,
  PENDING_SIGNATURE,
} from '../comfy-cors-notice'
import { useComfyNoticeStore } from '../../stores/comfyNoticeStore'

describe('comfyCorsSignature', () => {
  it('names the ComfyUI and its version', () => {
    expect(comfyCorsSignature('localhost', 8188, '0.33.0')).toBe('localhost:8188|0.33.0')
  })

  it('falls back to the placeholder when the version is missing', () => {
    expect(comfyCorsSignature('localhost', 8188, null)).toBe(`localhost:8188|${UNKNOWN_COMFY_VERSION}`)
    expect(comfyCorsSignature('localhost', 8188, '  ')).toBe(`localhost:8188|${UNKNOWN_COMFY_VERSION}`)
  })

  it('separates two different ComfyUIs and two different versions', () => {
    expect(comfyCorsSignature('localhost', 8188, '0.33.0'))
      .not.toBe(comfyCorsSignature('192.168.0.54', 8188, '0.33.0'))
    expect(comfyCorsSignature('localhost', 8188, '0.33.0'))
      .not.toBe(comfyCorsSignature('localhost', 8188, '0.34.0'))
  })
})

describe('shouldShowCorsNotice', () => {
  const SIG = 'localhost:8188|0.33.0'

  it('says nothing while no media load was blocked', () => {
    expect(shouldShowCorsNotice(false, SIG, null)).toBe(false)
  })

  it('shows the bar on a block nobody dismissed yet', () => {
    expect(shouldShowCorsNotice(true, SIG, null)).toBe(true)
    expect(shouldShowCorsNotice(true, null, null)).toBe(true)
  })

  /**
   * DER BEFUND SELBST (R18 Befund 1, Windows box, ComfyUI 0.33.0).
   *
   * Rueckwaerts gefahrene Negativkontrolle: die alte Bedingung war das nackte
   * `comfyCorsBlocked`, also true, sobald irgendein Vorschaubild ueber den
   * Proxy gerettet wurde. Genau dieser Ausdruck steht unten und ist nach dem
   * Wegklicken immer noch true. Die neue Regel ist es nicht.
   */
  it('THE FINDING: a dismissed bar stays gone across the next renders', () => {
    const blockedAgainByNextRender = true
    expect(blockedAgainByNextRender).toBe(true) // was die alte Bedingung sah
    expect(shouldShowCorsNotice(blockedAgainByNextRender, SIG, SIG)).toBe(false)
  })

  it('stays quiet after a dismissal while the signature is still loading', () => {
    expect(shouldShowCorsNotice(true, null, SIG)).toBe(false)
  })

  it('comes back once for a different ComfyUI or a new version', () => {
    expect(shouldShowCorsNotice(true, 'localhost:8188|0.34.0', SIG)).toBe(true)
    expect(shouldShowCorsNotice(true, 'lu-box:8188|0.33.0', SIG)).toBe(true)
  })
})

describe('loadComfyCorsSignature', () => {
  it('builds the signature from host, port and the reported version', async () => {
    const sig = await loadComfyCorsSignature({
      host: () => 'localhost', port: () => 8188, version: async () => '0.33.0',
    })
    expect(sig).toBe('localhost:8188|0.33.0')
  })

  it('still answers when ComfyUI reports no version at all', async () => {
    const sig = await loadComfyCorsSignature({
      host: () => 'localhost', port: () => 8188, version: async () => null,
    })
    expect(sig).toBe(`localhost:8188|${UNKNOWN_COMFY_VERSION}`)
  })

  it('survives a throwing version probe instead of losing the signature', async () => {
    const sig = await loadComfyCorsSignature({
      host: () => 'localhost', port: () => 8188, version: async () => { throw new Error('down') },
    })
    expect(sig).toBe(`localhost:8188|${UNKNOWN_COMFY_VERSION}`)
  })

  it('gives up honestly when there is no usable port', async () => {
    const sig = await loadComfyCorsSignature({
      host: () => 'localhost', port: () => 0, version: async () => '0.33.0',
    })
    expect(sig).toBeNull()
  })
})

describe('comfyNoticeStore', () => {
  beforeEach(() => {
    useComfyNoticeStore.setState({ corsNoticeDismissedFor: null })
  })

  it('remembers which cause was dismissed', () => {
    useComfyNoticeStore.getState().dismissCorsNotice('localhost:8188|0.33.0')
    expect(useComfyNoticeStore.getState().corsNoticeDismissedFor).toBe('localhost:8188|0.33.0')
  })

  it('records a dismissal made before the signature landed, then adopts it', () => {
    useComfyNoticeStore.getState().dismissCorsNotice(null)
    expect(useComfyNoticeStore.getState().corsNoticeDismissedFor).toBe(PENDING_SIGNATURE)
    // Ohne diese Uebernahme waere der Wegklick beim naechsten Render wertlos.
    expect(shouldShowCorsNotice(true, 'localhost:8188|0.33.0', PENDING_SIGNATURE)).toBe(true)
    useComfyNoticeStore.getState().adoptCorsSignature('localhost:8188|0.33.0')
    expect(useComfyNoticeStore.getState().corsNoticeDismissedFor).toBe('localhost:8188|0.33.0')
    expect(shouldShowCorsNotice(true, 'localhost:8188|0.33.0', 'localhost:8188|0.33.0')).toBe(false)
  })

  it('never overwrites a real dismissal with a later signature', () => {
    useComfyNoticeStore.getState().dismissCorsNotice('localhost:8188|0.33.0')
    useComfyNoticeStore.getState().adoptCorsSignature('localhost:8188|0.34.0')
    expect(useComfyNoticeStore.getState().corsNoticeDismissedFor).toBe('localhost:8188|0.33.0')
  })
})

describe('the Create tab actually uses the rule', () => {
  const src = readFileSync(
    join(__dirname, '../../components/create/experimental/CreateExperimental.tsx'),
    'utf-8',
  )

  it('gates the bar through shouldShowCorsNotice, not the bare session flag', () => {
    expect(src).toMatch(/shouldShowCorsNotice\(comfyCorsBlocked, corsSignature, corsNoticeDismissedFor\)/)
    // Negativkontrolle: die alte Bedingung darf nicht mehr im Markup stehen.
    expect(src).not.toMatch(/backend === 'local' && comfyCorsBlocked &&/)
  })

  it('records the dismissal on the X, or nothing would stick', () => {
    expect(src).toMatch(/dismissCorsNotice\(corsSignature\)/)
  })
})

describe('the dismissal is persisted like the other one-time notices', () => {
  it('lu_comfy_notice is a resettable settings key and survives an update', async () => {
    const { SETTINGS_STORAGE_KEYS } = await import('../fatal-error')
    const { STORE_KEYS } = await import('../store-backup')
    expect(SETTINGS_STORAGE_KEYS).toContain('lu_comfy_notice')
    expect(STORE_KEYS).toContain('lu_comfy_notice')
  })
})
