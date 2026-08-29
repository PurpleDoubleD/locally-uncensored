/**
 * A finished download is not a finished install.
 *
 * Voxyl AI, Discord #general 2026-08-13 17:00 UTC with a screenshot, confirmed
 * five minutes later by Aldrich Ironhart: on Extend Video and Animate Image the
 * Download and install button runs to the end and then sits on "Refreshing the
 * model list…" for good. Both have ComfyUI.
 *
 * Nothing was hanging. installModelBundle refreshed the list once, returned
 * happy, and Stage keeps the install card up until the model lists actually
 * refill. ComfyUI's directory scan was still running, so the lists came back
 * without the new file. That is not an error, which is why the retry loop in
 * useCreate (guarded on modelLoadError) never engaged either. Two dead ends
 * meeting at one frozen line of text. Image bundles fit through the old window
 * because they are a fraction of the size.
 *
 * This file covers the loop that was missing. The engine-facing half is
 * asserted at the source level below, the same way the codex gate test does it:
 * a React context around a live ComfyUI is not what should be mocked here.
 *
 * Run: npx vitest run src/lib/__tests__/model-visible-wait.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { waitForModelsVisible, InstallCancelled } from '../bundle-install'

const WANTED = ['wan2.2_s2v_14B_fp8.safetensors', 'wav2vec2_large_english.safetensors']

/** A ComfyUI whose scan finishes after `rounds` refreshes. */
function engine(rounds: number, missing = WANTED) {
  let seen = 0
  return {
    refresh: vi.fn(async () => { seen++ }),
    missing: vi.fn(async () => (seen >= rounds ? [] : missing)),
  }
}

describe('waiting for ComfyUI to list what was just downloaded', () => {
  it('returns at once when the files are already there', async () => {
    const e = engine(0)
    const left = await waitForModelsVisible({ missing: e.missing, refresh: e.refresh, delayMs: 1 })
    expect(left).toEqual([])
    expect(e.refresh).not.toHaveBeenCalled()
  })

  it('keeps refreshing until the scan catches up', async () => {
    const e = engine(3)
    const left = await waitForModelsVisible({ missing: e.missing, refresh: e.refresh, delayMs: 1 })
    expect(left).toEqual([])
    expect(e.refresh).toHaveBeenCalledTimes(3)
  })

  it('gives up after the attempt budget instead of spinning forever', async () => {
    const e = engine(999)
    const left = await waitForModelsVisible({ missing: e.missing, refresh: e.refresh, delayMs: 1, attempts: 4 })
    expect(left).toEqual(WANTED)
    expect(e.refresh).toHaveBeenCalledTimes(4)
  })

  it('reports only what is still missing, not the whole bundle', async () => {
    const e = engine(999, [WANTED[1]])
    const left = await waitForModelsVisible({ missing: e.missing, refresh: e.refresh, delayMs: 1, attempts: 2 })
    expect(left).toEqual([WANTED[1]])
  })

  it('the status line counts up, which is the whole point of the fix', async () => {
    // The bug the user saw was a line of text that never changed again. A
    // wait that says nothing is indistinguishable from a hang.
    const e = engine(3)
    const seen: string[] = []
    await waitForModelsVisible({ missing: e.missing, refresh: e.refresh, delayMs: 1000, onStatus: (m) => seen.push(m) })
    expect(seen).toEqual([
      'Waiting for ComfyUI to list the new files… 0s',
      'Waiting for ComfyUI to list the new files… 1s',
      'Waiting for ComfyUI to list the new files… 2s',
    ])
  })

  it('cancel gets out of the wait, it does not have to sit out the timer', async () => {
    const e = engine(999)
    const ac = new AbortController()
    const p = waitForModelsVisible({ missing: e.missing, refresh: e.refresh, delayMs: 60_000, signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(InstallCancelled)
  })
})

describe('the install path uses it, and says something honest when it runs out', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../components/create/experimental/CreateContext.tsx'),
    'utf8',
  )
  // The probe moved into discover.ts so the Model Manager download path can
  // use the same one. These assertions moved with it: they exist to catch
  // drift, which means they have to read the file that owns the code.
  const discoverSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../api/discover.ts'),
    'utf8',
  )

  it('the video bundle is picked by the lane rule, not by index', () => {
    // The bug this pins: the installer took getVideoBundles()[0] whatever the
    // lane was, so Extend Video and Animate Image were offered a Wan 2.1 T2V
    // bundle that their own gate rejects. 9.2 GB later the card was still
    // there, and pressing the button again did the same thing. Measured on the
    // box 2026-08-15.
    expect(src).toMatch(/bundleForVideoIntent\(getVideoBundles\(\), useCreateStore\.getState\(\)\.intent\(\)\)/)
    expect(src).not.toMatch(/kind === 'video' \? getVideoBundles\(\)/)
  })

  it('only the subfolders ComfyUI enumerates are checked', () => {
    // loras and upscale models never show up in these enums, so demanding
    // them would turn every install into a failure.
    expect(src).toMatch(/files\.filter\(\(f\) => ENUM_SUBFOLDERS\.has\(f\.subfolder!\)\)/)
  })

  it('an engine it cannot reach counts as nothing confirmed', () => {
    expect(discoverSrc).toMatch(/catch \{\s*\n\s*return wanted/)
  })

  it('it restarts the engine once before giving up', () => {
    // Self-heal before complaining: a restart rebuilds the model index for
    // certain. The old code had no second move at all.
    const wait = src.indexOf('waitForModelsVisible')
    const restart = src.indexOf('Restarting ComfyUI so it picks up the new files')
    const give = src.indexOf('but ComfyUI still does not list')
    expect(wait).toBeGreaterThan(-1)
    expect(restart).toBeGreaterThan(wait)
    expect(give).toBeGreaterThan(restart)
  })

  it('the last word is a thrown error, so the card turns red instead of freezing', () => {
    // The restart's own reason now sits ahead of the fallback text inside the
    // same throw, so the anchor is the throw plus the reason, not the literal.
    expect(src).toMatch(/throw new Error\(\s*\n\s*restartSaid \|\|\s*\n\s*`The files downloaded fine/)
  })

  it('the error names the two things that actually cause it', () => {
    expect(src).toContain('reading a different model folder')
    expect(src).toContain('started ')
    expect(src).toContain('outside LU')
  })

  it('the probe asks the GGUF loader too, or the default lipsync bundle can never pass', () => {
    // UNETLoader only enumerates .safetensors and .sft (comfyui.ts:659), and
    // getLipsyncBundles()[0] ships Wan2.2-S2V-14B-Q4_K_M.gguf into
    // diffusion_models, which IS in ENUM_SUBFOLDERS. Without the GGUF loader
    // the probe fails for a file ComfyUI lists perfectly well: 20 rounds of
    // waiting, an uncalled-for engine restart, then a wrong diagnosis.
    //
    // B1 (2.6.7): the loader list moved into one reader, readComfyModelNames,
    // because the three paths that ask "can ComfyUI see this file" each had
    // their own copy and they drifted. checkBundlesInstalled was taught the
    // GGUF loader in 2.6.6 and this probe was born with it, while the Model
    // Manager's install click kept asking four loaders and told users LU and
    // ComfyUI use different model folders for a GGUF the engine serves fine.
    // The guard pins the reader AND that both callers go through it.
    const reader = discoverSrc.slice(
      discoverSrc.indexOf('export async function readComfyModelNames'),
      discoverSrc.indexOf('/** Which of `wanted`'),
    )
    expect(reader).toContain('getGgufUnetModels()')
    expect(discoverSrc).toMatch(/import \{[^}]*getGgufUnetModels[^}]*\} from "\.\/comfyui"/)
    const probe = discoverSrc.slice(
      discoverSrc.indexOf('export async function modelsNotVisibleInComfy'),
      discoverSrc.indexOf('/** #72:'),
    )
    expect(probe).toContain('readComfyModelNames()')
    const installClick = discoverSrc.slice(
      discoverSrc.indexOf('const readVisibleBases ='),
      discoverSrc.indexOf('const comfyCanSee ='),
    )
    expect(installClick).toContain('readComfyModelNames()')
    // And the caller still runs it through the wait rather than once.
    expect(src).toContain('missing: stillMissing, refresh: refreshLists')
    expect(src).toContain('const stillMissing = () => modelsNotVisibleInComfy(wanted)')
  })

  it('the heal waits for a live render instead of killing it', () => {
    // An install runs on for minutes after Stage swapped its card away, so
    // without this the bundle could stop the engine in the middle of somebody
    // else's video and leave a dead job and no explanation behind.
    // Anchored on the call site, not on the helper: a guard that exists but is
    // never called is exactly the bug this pins.
    const call = src.indexOf('await waitForIdleRender(signal)')
    const restart = src.indexOf('Restarting ComfyUI so it picks up the new files')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(restart)
    expect(src).toContain('Waiting for the current render to finish before restarting ComfyUI')
  })

  it('waiting for the render to finish is bounded, an install must not park forever', () => {
    expect(src).toMatch(/async function waitForIdleRender\(signal\?: AbortSignal, attempts = \d+\)/)
  })

  // P7 from the review (2026-08-14). The heal swallowed the restart's own
  // error, which is the precise one, and then guessed between two causes. And
  // the follow-up wait was 10 rounds of 3s, which had to cover the engine boot
  // AND the directory scan, while this same file budgets 15 rounds of 2s for a
  // warm boot alone and 30 for one after an install. On the 12 GB bundles the
  // scan is the slow half, so a perfectly good install was told its model
  // folder was wrong.
  it('the restart reason is kept and preferred over the guess', () => {
    expect(src).toContain('restartSaid = e instanceof Error ? e.message : String(e)')
    const throwAt = src.indexOf('The files downloaded fine, but ComfyUI still does not list')
    expect(src.slice(throwAt - 200, throwAt)).toContain('restartSaid ||')
  })

  it('the engine gets the same time to come back that a warm boot gets', () => {
    expect(src).toContain('await waitForComfyBack(onProgress, signal)')
    expect(src).toMatch(/for \(let i = 0; i < 15; i\+\+\) \{\s*\n\s*if \(await checkComfyConnection\(\)\) return true/)
  })

  it('the second visibility wait gets the full budget, not a shortened one', () => {
    const heal = src.slice(src.indexOf('Restarting ComfyUI so it picks up the new files'))
    const secondWait = heal.slice(0, heal.indexOf('if (missing.length > 0)'))
    expect(secondWait).not.toContain('attempts: 10')
  })

  it('coming back up must not trigger a multi gigabyte install behind the download', () => {
    // Endanker ist der Kommentar der naechsten Deklaration. Vorher stand hier
    // `restartComfyForNewNodes`, die seit dem 15.08. in `api/comfy-restart.ts`
    // liegt, weil der Generate-Pfad dieselbe Fassung braucht. Ein Anker, der
    // nicht mehr existiert, liefert -1 und schneidet die ganze Datei mit.
    const helper = src.slice(src.indexOf('async function waitForComfyBack'), src.indexOf('The seam between the redesigned Create surface'))
    expect(helper).not.toContain('install_comfyui')
  })
})

describe('the card is no longer the owner of the run', () => {
  const stage = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../components/create/experimental/Stage.tsx'),
    'utf8',
  )

  it('ModelInstallCard reads the run from the lane registry, not from its own state', () => {
    const card = stage.slice(stage.indexOf('function ModelInstallCard'), stage.indexOf('function TrainSetBoard'))
    expect(card).toContain('useSyncExternalStore(subscribeInstallRuns')
    expect(card).toContain('startInstallRun(kind')
    expect(card).toContain('cancelInstallRun(kind)')
    // The old shape: local useState plus an abortRef that nothing ever cleaned
    // up on unmount. Both are gone, and with them the headless run.
    expect(card).not.toContain('abortRef')
    expect(card).not.toContain('setInstalling(')
  })
})
