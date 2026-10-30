// The side effects lib/render-fixups.ts needs, wired to the app. One place,
// because every local render asks the same way: Create (all lanes and the
// prompt enhancer) and the agent's image and video tool (api/vram-handoff.ts).
// The question itself is drawn by RenderFixupModal in the app shell.

import { checkComfyConnection, refreshComfyModels } from './comfyui'
import { clearNodeCache } from './comfyui-nodes'
import { startModelDownload, getDownloadProgress, modelsNotVisibleInComfy, comfyModelTarget, catalogDigestFor } from './discover'
import { downloadBundleFiles, waitForModelsVisible } from '../lib/bundle-install'
import { WAITING_FOR_ANSWER, type FixupDeps } from '../lib/render-fixups'
import { useCreateStore } from '../stores/createStore'
import { useDownloadStore } from '../stores/downloadStore'
import { useComfyInstallStore } from '../stores/comfyInstallStore'

/** How long the updated ComfyUI gets to answer. The update starts it again
 *  itself (update_comfyui in Rust, before it reports complete), so this only
 *  waits for the port. */
const COMFY_BACK_UP_TRIES = 90
const POLL_MS = 2000

export function renderFixupDeps(onStatus: (line: string) => void, signal?: AbortSignal): FixupDeps {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const refreshLists = async () => {
    await refreshComfyModels().catch(() => false)
    clearNodeCache()
  }
  return {
    ask: (prompt) => new Promise<boolean>((resolve) => {
      onStatus(WAITING_FOR_ANSWER)
      useCreateStore.getState().setFixupPrompt({
        ...prompt,
        resolve: (go) => { useCreateStore.getState().setFixupPrompt(null); resolve(go) },
      })
    }),
    download: async (files) => {
      const dl = useDownloadStore.getState()
      for (const f of files) dl.setMeta(f.downloadFilename, f.downloadUrl, f.subfolder)
      dl.startPolling()
      await downloadBundleFiles(
        files.map((f) => ({ filename: f.downloadFilename, subfolder: f.subfolder, downloadUrl: f.downloadUrl, sizeGB: f.sizeGB, sha256: f.sha256 ?? catalogDigestFor(f.downloadFilename, f.downloadUrl).sha256 })),
        {
          start: startModelDownload,
          progress: getDownloadProgress,
          onStatus,
          keepTrayLive: () => useDownloadStore.getState().startPolling(),
          stop: (filename) => { void useDownloadStore.getState().cancel(filename) },
          signal,
        },
      )
      // A ComfyUI on another machine cannot list them before they are copied
      // over; buildWithFixups says so (GH #143).
      if ((await comfyModelTarget()).remote) return
      const wanted = files.map((f) => f.downloadFilename)
      const left = await waitForModelsVisible({ missing: () => modelsNotVisibleInComfy(wanted), refresh: refreshLists, onStatus, signal })
      if (left.length > 0) throw new Error(`Downloaded ${left.join(', ')}, but ComfyUI does not list ${left.length === 1 ? 'it' : 'them'} yet. Restart ComfyUI and hit Create again.`)
    },
    remote: async () => {
      const t = await comfyModelTarget()
      return t.remote && t.host && t.root ? { host: t.host, root: t.root } : null
    },
    updateComfy: async () => {
      onStatus('Updating ComfyUI…')
      await useComfyInstallStore.getState().runUpdate()
      for (;;) {
        await sleep(POLL_MS)
        const st = useComfyInstallStore.getState()
        if (st.phase === 'error') throw new Error(st.error || 'Updating ComfyUI did not finish.')
        if (st.phase === 'idle') break
        const last = st.logs[st.logs.length - 1]
        if (last) onStatus(String(last))
      }
      for (let i = 0; i < COMFY_BACK_UP_TRIES; i++) {
        if (await checkComfyConnection()) return
        onStatus(`Starting the updated ComfyUI… ${i * 2}s`)
        await sleep(POLL_MS)
      }
      throw new Error('ComfyUI was updated but did not come back up. Start it from Settings and hit Create again.')
    },
    refresh: refreshLists,
  }
}
