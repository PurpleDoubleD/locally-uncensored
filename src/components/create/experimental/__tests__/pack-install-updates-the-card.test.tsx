// @vitest-environment jsdom
/**
 * Swap setup on the RTX 5080, 22.11.2026: "Download & install" put the pose
 * pack in, ComfyUI listed DWPreprocessor, and the card still asked for the
 * pack. Its button would have pulled it and restarted ComfyUI a second time.
 */
import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

const m = vi.hoisted(() => ({
  getAllNodeInfo: vi.fn(),
  installCustomNodes: vi.fn(),
  nodePacksNotLoaded: vi.fn(),
  restart: vi.fn(),
}))

vi.mock('../../../../hooks/useCreate', () => ({
  useCreate: () => ({
    generate: vi.fn(), cancel: vi.fn(), samplerList: [], schedulerList: [], connected: false,
    modelsLoaded: true, modelLoadError: null, mlxMissing: false,
    checkConnection: vi.fn(async () => true), fetchModels: vi.fn(async () => undefined),
  }),
}))
vi.mock('../../../../hooks/useRereadOnReturn', () => ({ useRereadOnReturn: () => undefined }))
vi.mock('../../../../hooks/useCloudCreate', () => ({
  useCloudCreate: () => ({}), hasActiveCloudRun: () => false,
}))
vi.mock('../../../../hooks/useCloudSession', () => ({
  useCloudSession: () => ({ cloudAvailable: false, quota: null, refreshQuota: vi.fn() }),
}))
vi.mock('../../../../api/comfyui', () => ({
  listedLoras: vi.fn(async () => []), getVAEModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => true), refreshComfyModels: vi.fn(async () => true),
}))
vi.mock('../../../../api/comfyui-nodes', () => ({
  getAllNodeInfo: m.getAllNodeInfo, clearNodeCache: vi.fn(),
}))
vi.mock('../../../../api/discover', () => ({
  installCustomNodes: m.installCustomNodes, nodePacksNotLoaded: m.nodePacksNotLoaded,
  assertBundleFits: vi.fn(async () => undefined),
  checkBundlesOnDisk: vi.fn(async () => ({ files: [] })),
  startModelDownload: vi.fn(), getDownloadProgress: vi.fn(),
  modelsNotVisibleInComfy: vi.fn(async () => []), judgeableFolders: vi.fn(async () => new Set()),
}))
vi.mock('../../../../lib/starter-bundle', () => ({
  starterBundleFor: () => ({ name: 'Swap', files: [], customNodes: ['controlnet-aux'] }),
}))
vi.mock('../../../../api/comfy-restart', () => ({ restartComfyForNewNodes: m.restart }))
vi.mock('../../../../api/backend', async (original) => ({
  ...(await original<typeof import('../../../../api/backend')>()),
  backendCall: vi.fn(async () => ({ running: true })), isMacOS: () => false, isLinux: () => false,
}))
vi.mock('../../../../lib/bundle-install', async (original) => ({
  ...(await original<typeof import('../../../../lib/bundle-install')>()),
  waitOrAbort: vi.fn(async () => undefined),
  downloadBundleFiles: vi.fn(async () => undefined),
}))

import { CreateExpProvider, useCreateExp } from '../CreateContext'
import { useCreateStore } from '../../../../stores/createStore'

type Api = ReturnType<typeof useCreateExp>
function Grab({ onApi }: { onApi: (api: Api) => void }) {
  const api = useCreateExp()
  useEffect(() => { onApi(api) })
  return null
}

const catalogue = (...names: string[]) =>
  Object.fromEntries(['KSampler', ...names].map((n) => [n, {}]))

async function install() {
  let api: Api | undefined
  render(<CreateExpProvider><Grab onApi={(a) => { api = a }} /></CreateExpProvider>)
  await act(async () => {
    const run = api!.installModelBundle('motion')
    await vi.advanceTimersByTimeAsync(30_000)
    await run
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  m.installCustomNodes.mockResolvedValue(undefined)
  m.nodePacksNotLoaded.mockResolvedValue(['controlnet-aux'])
  m.restart.mockResolvedValue(undefined)
  useCreateStore.setState({
    caps: { rmbg: false, 'inpaint-nodes': true, dwpose: false, depth: false },
  } as never)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the capability card after a bundle installed its node pack', () => {
  it('goes away when ComfyUI lists the node, with one install and one restart', async () => {
    m.getAllNodeInfo.mockResolvedValue(catalogue('DWPreprocessor', 'DepthAnythingV2Preprocessor'))
    await install()
    expect(useCreateStore.getState().caps.dwpose).toBe(true)
    expect(useCreateStore.getState().caps.depth).toBe(true)
    expect(m.installCustomNodes).toHaveBeenCalledTimes(1)
    expect(m.restart).toHaveBeenCalledTimes(1)
  })

  it('stays when ComfyUI answers without the node', async () => {
    m.getAllNodeInfo.mockResolvedValue(catalogue())
    await install()
    expect(useCreateStore.getState().caps.dwpose).toBe(false)
  })

  it('waits through a ComfyUI that is still coming up', async () => {
    m.getAllNodeInfo
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({})
      .mockResolvedValue(catalogue('DWPreprocessor'))
    await install()
    expect(useCreateStore.getState().caps.dwpose).toBe(true)
  })

  it('keeps what it knew when ComfyUI never answers', async () => {
    useCreateStore.setState({
      caps: { rmbg: true, 'inpaint-nodes': true, dwpose: false, depth: false },
    } as never)
    m.getAllNodeInfo.mockRejectedValue(new Error('connection refused'))
    await install()
    expect(useCreateStore.getState().caps.rmbg).toBe(true)
  })

  it('does not touch the caps or restart when no pack was missing', async () => {
    m.nodePacksNotLoaded.mockResolvedValue([])
    await install()
    expect(m.installCustomNodes).not.toHaveBeenCalled()
    expect(m.restart).not.toHaveBeenCalled()
    expect(useCreateStore.getState().caps.dwpose).toBe(false)
  })
})
