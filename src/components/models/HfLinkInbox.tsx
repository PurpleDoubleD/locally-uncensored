import { useEffect } from 'react'
import { backendCall, isTauri } from '../../api/backend'
import { readInbound } from '../../lib/hf-link'
import { log } from '../../lib/logger'
import { useHfLinkStore } from '../../stores/hfLinkStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'

/** Models, Chat lane, Discover: where the dialog about the link lives. */
function openModelsForLink(): void {
  useModelStore.getState().setCategoryFilter('text')
  useUIStore.getState().setView('models')
}

/** Take what waits in the inbox (src-tauri/src/hf_link.rs) and route it. */
export async function takeHfLink(): Promise<void> {
  let raw: unknown
  try {
    raw = await backendCall('hf_link_take')
  } catch (e) {
    log.warn('[hf-link] inbox not readable', { err: e })
    return
  }
  if (raw == null) return
  const inbound = readInbound(raw)
  const store = useHfLinkStore.getState()
  if (!inbound) {
    store.reject('The link could not be read.')
    return
  }
  if (inbound.kind === 'rejected') {
    store.reject(inbound.reason)
    return
  }
  const inCloud = useSettingsStore.getState().settings.appMode === 'cloud'
  store.offer(inbound.link, inCloud)
  if (!inCloud) openModelsForLink()
}

/**
 * The receiving end of `locallyuncensored://open-model` links. Mounted once in
 * the app shell. It only routes: the question about the download itself is
 * asked in Models (HfLinkDialog). What it shows itself is the two cases that
 * never get there: a link that failed the check, and a link that arrives
 * while the app is in cloud mode, where Models does not exist.
 */
export function HfLinkInbox() {
  const rejected = useHfLinkStore((s) => s.rejected)
  const pending = useHfLinkStore((s) => s.pending)
  const needsLocal = useHfLinkStore((s) => s.needsLocal)
  const clear = useHfLinkStore((s) => s.clear)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let off: (() => void) | null = null
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const unlisten = await listen('hf-link', () => { void takeHfLink() })
      if (cancelled) unlisten()
      else off = unlisten
      // The link that started the app came before this listener.
      void takeHfLink()
    })()
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  if (rejected) {
    return (
      <Modal open onClose={clear} title="Link not opened">
        <div className="space-y-2" data-testid="hf-link-rejected">
          <p className="t-body text-gray-700 dark:text-gray-200">{rejected}</p>
          <p className="t-micro text-gray-500">
            Nothing was downloaded. Links from Hugging Face&apos;s &quot;Use this model&quot; button open a GGUF model in Models.
          </p>
          <ModalActions>
            <ModalButton variant="primary" onClick={clear}>OK</ModalButton>
          </ModalActions>
        </div>
      </Modal>
    )
  }

  if (pending && needsLocal) {
    return (
      <Modal open onClose={clear} title="Open in Local mode?">
        <div className="space-y-2" data-testid="hf-link-needs-local">
          <p className="t-body text-gray-700 dark:text-gray-200">
            <span className="t-mono break-all">{pending.repo}</span> runs on this computer. Models is part of Local mode.
          </p>
          <ModalActions>
            <ModalButton variant="quiet" onClick={clear}>Not now</ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => {
                useSettingsStore.getState().updateSettings({ appMode: 'local' })
                useHfLinkStore.getState().setNeedsLocal(false)
                openModelsForLink()
              }}
            >
              Switch to Local
            </ModalButton>
          </ModalActions>
        </div>
      </Modal>
    )
  }

  return null
}
