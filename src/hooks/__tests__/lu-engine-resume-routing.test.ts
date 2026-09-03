/**
 * @vitest-environment jsdom
 *
 * A14 (2.6.8): `list_bundled_models` is asked unconditionally now, and the two
 * boot-resume paths hang off that same answer. The chat engine is resumed only
 * while it holds the slot; the bundled embeddings server is resumed while it
 * does not, so Document Chat survives a relaunch under LM Studio or Ollama.
 * Folding the two calls into one made it easy to route both down one branch,
 * which would either boot a chat engine nothing sends to or take RAG offline
 * after every restart. So the fork is pinned from both sides.
 *
 * `builtinResumeAttempted` is module state, once per app session, so each case
 * re-imports the hook to start from a fresh app.
 *
 * Run: npx vitest run src/hooks/__tests__/lu-engine-resume-routing.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const bundledEngineStatus = vi.fn(async () => ({ running: false, healthy: false, port: 8127 }))
const bundledEmbedStatus = vi.fn(async () => ({ running: false, healthy: false, port: 8128 }))
const startBundledEmbed = vi.fn(async () => ({ ok: true }))
const activateBuiltinModel = vi.fn(async () => true)
let managedBuiltin = false

const CHAT = { name: 'Qwen2.5-0.5B-Instruct-Q8_0', path: '/m/Qwen2.5-0.5B-Instruct-Q8_0.gguf', size: 1, loaded: false }
const EMBED = { name: 'nomic-embed-text-v1.5.Q4_K_M', path: '/m/nomic-embed-text-v1.5.Q4_K_M.gguf', size: 1, loaded: false }

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => true,
  isWindows: () => false,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
}))
vi.mock('../../api/comfyui', () => ({
  getInstalledImageModels: vi.fn(async () => []),
  getInstalledVideoModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => false),
  readModelDiskSizes: vi.fn(async () => new Map()),
}))
vi.mock('../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  pullModel: vi.fn(),
  pullModelTauri: vi.fn(),
  deleteModel: vi.fn(),
}))
vi.mock('../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../api/providers')>('../../api/providers')
  return { ...actual, getEnabledProviders: () => [] }
})
const listBundledModels = vi.fn(async () => [CHAT, EMBED])
vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listBundledModels: (...a: unknown[]) => listBundledModels(...(a as [])),
    isManagedBuiltinActive: () => managedBuiltin,
    bundledEngineStatus,
    bundledEmbedStatus,
    startBundledEmbed,
    activateBuiltinModel,
  }
})

/** One fresh app session. Returns a way to refresh again in the SAME session. */
async function bootAndRefresh() {
  vi.resetModules()
  const { useModels } = await import('../useModels')
  const { result } = renderHook(() => useModels())
  const refresh = async () => {
    await act(async () => { await result.current.fetchModels() })
    // The resumes are fired without await on purpose, so the list is not held
    // hostage by a cold engine start. Let those microtasks land.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
  await refresh()
  return refresh
}

beforeEach(() => {
  listBundledModels.mockReset()
  listBundledModels.mockResolvedValue([CHAT, EMBED])
  bundledEngineStatus.mockClear()
  bundledEmbedStatus.mockClear()
  startBundledEmbed.mockClear()
  activateBuiltinModel.mockClear()
})

describe('the boot resume goes to the right process', () => {
  it('under a foreign chat backend: the embeddings server, and never the chat engine', async () => {
    managedBuiltin = false
    await bootAndRefresh()
    expect(startBundledEmbed, 'RAG has to survive a relaunch under LM Studio or Ollama').toHaveBeenCalledWith(EMBED.path)
    // NEGATIVE CONTROL in the same frame: booting the chat engine here would
    // put a model in memory that no request is routed to.
    expect(bundledEngineStatus).not.toHaveBeenCalled()
  })

  it('while the LU Engine holds the chat: both, exactly as before', async () => {
    managedBuiltin = true
    await bootAndRefresh()
    expect(bundledEngineStatus).toHaveBeenCalled()
    expect(startBundledEmbed).toHaveBeenCalledWith(EMBED.path)
  })
})

// ── A14 review 6: the boot resume is a BOOT resume ──────────────────────────

describe('the once-per-session flag is raised on the attempt, not on the success', () => {
  it('a machine with no sidecar does not re-attempt the resume on every refresh', async () => {
    managedBuiltin = true
    // No sidecar, and the backend SAYS so: the command is not in this build's
    // invoke handler, which is the web and remote-bridge case and a broken
    // install. A refusal is an answer, so the one shot is spent.
    // The literal from src/api/backend.ts, not an invented wording:
    // the HTTP bridge's endpoint table throws exactly this.
    listBundledModels.mockRejectedValue(new Error('Unknown backend command: list_bundled_models'))
    const refresh = await bootAndRefresh()
    expect(startBundledEmbed).not.toHaveBeenCalled()
    expect(bundledEngineStatus).not.toHaveBeenCalled()

    // fetchModels runs from several mounted components and on every refresh
    // event. With the flag raised only after a SUCCESSFUL call, the engine
    // that starts answering an hour into the session would get a boot resume
    // an hour after boot, evicting Ollama's residents and dropping ComfyUI's
    // VRAM cache for a start nobody asked for.
    listBundledModels.mockResolvedValue([CHAT, EMBED])
    await refresh()
    expect(bundledEngineStatus, 'a boot resume an hour after boot').not.toHaveBeenCalled()
    expect(startBundledEmbed).not.toHaveBeenCalled()
  })

  // NEGATIVE CONTROL: the boot resume must still happen at boot. A flag raised
  // too eagerly would turn this whole mechanism off.
  it('but the first pass of a working session still resumes', async () => {
    managedBuiltin = true
    const refresh = await bootAndRefresh()
    expect(bundledEngineStatus).toHaveBeenCalled()
    // ...and exactly once, however often the list is refreshed afterwards.
    bundledEngineStatus.mockClear()
    await refresh()
    await refresh()
    expect(bundledEngineStatus).not.toHaveBeenCalled()
  })
})

// ── A14 second review 3: a launch race is not an answer ─────────────────────

describe('a call that never got through does not spend the one shot', () => {
  it('a timeout on the first refresh leaves the resume owed', async () => {
    managedBuiltin = true
    // The moment this actually runs: right after launch, antivirus scanning
    // the fresh install, the command layer still coming up behind the window.
    // Spending the shot here left the engine the user had running yesterday
    // dead until he re-picked the model by hand, which is GH #118 again.
    listBundledModels.mockRejectedValue(new Error('invoke timed out after 5000ms'))
    const refresh = await bootAndRefresh()
    expect(bundledEngineStatus).not.toHaveBeenCalled()

    // Half a second later the backend is up and the next refresh gets through.
    listBundledModels.mockResolvedValue([CHAT, EMBED])
    await refresh()
    expect(bundledEngineStatus, 'the resume was still owed').toHaveBeenCalled()
    expect(startBundledEmbed).toHaveBeenCalledWith(EMBED.path)

    // And now it is spent, so it does not run a third time.
    bundledEngineStatus.mockClear()
    await refresh()
    expect(bundledEngineStatus).not.toHaveBeenCalled()
  })

  it('a dead transport counts the same as a timeout', async () => {
    managedBuiltin = true
    listBundledModels.mockRejectedValue(new Error('Failed to fetch'))
    const refresh = await bootAndRefresh()
    listBundledModels.mockResolvedValue([CHAT, EMBED])
    await refresh()
    expect(bundledEngineStatus).toHaveBeenCalled()
  })

  // NEGATIVE CONTROL: the refusal really must still spend it, or the web build
  // asks the same dead question on every single model refresh forever.
  it('but a plain refusal still spends it', async () => {
    managedBuiltin = true
    listBundledModels.mockRejectedValue(new Error('Unknown backend command: list_bundled_models'))
    const refresh = await bootAndRefresh()
    listBundledModels.mockResolvedValue([CHAT, EMBED])
    await refresh()
    expect(bundledEngineStatus).not.toHaveBeenCalled()
  })
})

// ── A14 third review: two mounted components are two first passes ───────────

describe('two overlapping first passes', () => {
  /** Both passes wait on ONE pending list call, which is what the launch race
   *  looks like: the Models page and the composer both mount, both ask, and
   *  the backend answers both at once. */
  async function twoPassesOn(answer: () => Promise<unknown>) {
    vi.resetModules()
    const { useModels } = await import('../useModels')
    listBundledModels.mockImplementation(answer as never)
    const a = renderHook(() => useModels())
    const b = renderHook(() => useModels())
    const both = async () => {
      await act(async () => {
        await Promise.all([a.result.current.fetchModels(), b.result.current.fetchModels()])
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    }
    await both()
    return both
  }

  it('start the boot resume once, not twice', async () => {
    managedBuiltin = true
    // The flag used to be READ before the await and WRITTEN after it, so both
    // passes read "first pass" and both fired the resume: two llama-server
    // starts on one port, on the machine with the least room to spare.
    // resumeEmbedServer runs once per resume, so its start counts them.
    await twoPassesOn(async () => [CHAT, EMBED])
    expect(startBundledEmbed).toHaveBeenCalledTimes(1)
  })

  // NEGATIVE CONTROL: the claim is given back when nothing was learned. Two
  // passes that both lose the launch race must leave the resume owed, exactly
  // as one pass does, or the Runde-3 contract dies the moment a second
  // component is mounted.
  it('leave the resume owed when neither of them got an answer', async () => {
    managedBuiltin = true
    const again = await twoPassesOn(async () => { throw new Error('invoke timed out after 5000ms') })
    expect(startBundledEmbed).not.toHaveBeenCalled()
    listBundledModels.mockImplementation(async () => [CHAT, EMBED] as never)
    await again()
    expect(bundledEngineStatus, 'the resume was still owed').toHaveBeenCalled()
    expect(startBundledEmbed).toHaveBeenCalledTimes(1)
  })

  // NEGATIVE CONTROL: a refusal still spends the shot, even when the pass that
  // heard it was racing another one.
  it('spend the shot once on a refusal, and never ask again', async () => {
    managedBuiltin = true
    const again = await twoPassesOn(async () => {
      throw new Error('Unknown backend command: list_bundled_models')
    })
    listBundledModels.mockImplementation(async () => [CHAT, EMBED] as never)
    await again()
    expect(bundledEngineStatus).not.toHaveBeenCalled()
    expect(startBundledEmbed).not.toHaveBeenCalled()
  })
})
