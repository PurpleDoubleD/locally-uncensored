import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, GitBranch, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import {
  FOREIGN_CODE_NOTICE,
  RESTART_NOTICE,
  installNodePackFromLink,
  listNodePacks,
  parseNodeRepoLink,
  removeNodePack,
  updateNodePack,
  whyNoUpdate,
  type NodePack,
  type NodePackList,
} from '../../api/custom-node-packs'
import { restartComfyForNewNodes } from '../../api/comfy-restart'
import { useNodePackLog } from '../../hooks/useNodePackLog'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { GitInstallButton } from '../ui/GitInstallButton'
import { isGitMissing } from '../../lib/git-missing'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const BTN_ACCENT = 'px-2 py-1 rounded t-micro bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30'
const BTN_PLAIN = 'px-2 py-1 rounded t-micro bg-white/5 text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors disabled:opacity-30'

/** "github.com/owner/repo" for a list row. */
function shortOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\.git$/, '')
}

function stateLine(pack: NodePack): string {
  const parts: string[] = []
  if (pack.branch) parts.push(pack.branch)
  else if (pack.commit) parts.push('pinned')
  if (pack.commit) parts.push(pack.commit)
  if (pack.committedAt) parts.push(pack.committedAt.slice(0, 10))
  return parts.join(' · ')
}

type Busy = { kind: 'install' | 'update' | 'remove' | 'restart'; label: string }

/**
 * Settings, ComfyUI node packs (GitHub wish #14): what sits in
 * ComfyUI/custom_nodes, a field for a Git link, Update and Remove per pack.
 * Windows and Linux only; the Mac has no ComfyUI and never renders this.
 */
export function CustomNodesSettings() {
  const [list, setList] = useState<NodePackList | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [link, setLink] = useState('')
  const [confirming, setConfirming] = useState<{ url: string; folder: string } | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const log = useNodePackLog()
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setList(await listNodePacks())
      setLoadError('')
    } catch (e) {
      setLoadError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current) }, [])

  const parsed = link.trim() ? parseNodeRepoLink(link) : null

  const run = async (next: Busy, work: () => Promise<string>) => {
    setBusy(next)
    setError('')
    setDone('')
    setArmed(null)
    await log.start()
    try {
      setDone(await work())
    } catch (e) {
      setError(errorText(e))
    } finally {
      await log.stop()
      setBusy(null)
      void refresh()
    }
  }

  const install = (url: string, folder: string) => {
    setConfirming(null)
    void run({ kind: 'install', label: `Installing ${folder}…` }, async () => {
      await installNodePackFromLink(url)
      setLink('')
      setNeedsRestart(true)
      return `${folder} is installed. ${RESTART_NOTICE}`
    })
  }

  const update = (pack: NodePack) => {
    void run({ kind: 'update', label: `Updating ${pack.name}…` }, async () => {
      await updateNodePack(pack)
      setNeedsRestart(true)
      return `${pack.name} is up to date. ${RESTART_NOTICE}`
    })
  }

  const remove = (pack: NodePack) => {
    if (armed !== pack.folder) {
      setArmed(pack.folder)
      if (armTimer.current) clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArmed((a) => (a === pack.folder ? null : a)), 3000)
      return
    }
    void run({ kind: 'remove', label: `Moving ${pack.name} to the trash…` }, async () => {
      const restarted = await removeNodePack(pack)
      if (restarted) return `${pack.name} is in the trash. ComfyUI was restarted on the way.`
      if (pack.enabled) setNeedsRestart(true)
      return pack.enabled ? `${pack.name} is in the trash. ${RESTART_NOTICE}` : `${pack.name} is in the trash.`
    })
  }

  const restart = () => {
    void run({ kind: 'restart', label: 'Restarting ComfyUI…' }, async () => {
      await restartComfyForNewNodes()
      setNeedsRestart(false)
      return 'ComfyUI restarted with the current node packs.'
    })
  }

  const packs = list?.packs ?? []
  const unavailable = list && !list.available ? list.reason : ''

  return (
    <div className="space-y-2" data-testid="custom-nodes-settings">
      <p className="t-micro text-gray-500 leading-relaxed">
        Node packs add new node types to ComfyUI, for example for workflows you import. They live in the
        custom_nodes folder of your ComfyUI.
      </p>

      {loadError && <p className={`t-micro ${HINWEIS_TEXT.fehler}`}>{loadError}</p>}
      {unavailable && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>{unavailable}</p>}

      {!unavailable && (
        <div className="space-y-1">
          <span className="t-body text-gray-700 dark:text-gray-400">Install from a Git link</span>
          <div className="flex gap-1.5">
            <input
              type="text"
              aria-label="Git link of a node pack"
              value={link}
              onChange={(e) => { setLink(e.target.value); setConfirming(null); setError('') }}
              placeholder="https://github.com/owner/repo"
              className="flex-1 min-w-0 px-2 py-1 rounded-lg border t-micro font-mono bg-transparent border-white/10 text-gray-300 focus:outline-none focus:border-white/25"
            />
            <button
              onClick={() => { if (parsed?.ok) setConfirming({ url: parsed.url, folder: parsed.folder }) }}
              disabled={!parsed?.ok || busy !== null || !!confirming}
              className={BTN_ACCENT}
            >
              Install
            </button>
          </div>
          {parsed && !parsed.ok && <p className={`t-micro ${HINWEIS_TEXT.ruhig}`}>{parsed.reason}</p>}
          {confirming && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 space-y-1.5" data-testid="node-pack-confirm">
              <p className="t-micro text-gray-300 leading-relaxed">{FOREIGN_CODE_NOTICE}</p>
              <p className="t-micro text-gray-500 font-mono break-all">
                {confirming.url} into custom_nodes/{confirming.folder}
              </p>
              <p className="t-micro text-gray-500">
                LU clones the repository and installs its requirements.txt into the Python of your ComfyUI.
              </p>
              <div className="flex gap-1.5">
                <button onClick={() => install(confirming.url, confirming.folder)} className={BTN_ACCENT}>
                  Install {confirming.folder}
                </button>
                <button onClick={() => setConfirming(null)} className={BTN_PLAIN}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-1.5 t-micro text-gray-400">
          <Loader2 size={11} className="animate-spin shrink-0" />
          <span>{busy.label}</span>
        </div>
      )}
      {log.lines.length > 0 && (
        <div className="space-y-0.5">
          <div
            className="bg-black/50 rounded p-1.5 max-h-40 overflow-y-auto font-mono t-micro text-gray-500 space-y-0.5"
            data-testid="node-pack-log"
          >
            {(showLog ? log.lines : log.lines.slice(-8)).map((line, i) => (
              <div key={i} className="break-all">{line}</div>
            ))}
          </div>
          {log.lines.length > 8 && (
            <button onClick={() => setShowLog((s) => !s)} className="t-micro text-gray-500 hover:text-gray-300">
              {showLog ? 'Show the last lines only' : `Show the full log (${log.lines.length} lines)`}
            </button>
          )}
        </div>
      )}
      {error && <p className={`t-micro whitespace-pre-line ${HINWEIS_TEXT.fehler}`}>{error}</p>}
      {/* 3.1.3: git is missing, so the button that gets it. The pack is
          installed again by hand: which one was meant is the user's call. */}
      {isGitMissing(error) && <GitInstallButton onReady={() => setError('')} />}
      {done && !busy && <p className="t-micro text-emerald-400">{done}</p>}
      {needsRestart && !busy && (
        <button onClick={restart} className={`${BTN_ACCENT} inline-flex items-center gap-1`}>
          <RotateCcw size={10} /> Restart ComfyUI
        </button>
      )}

      {!unavailable && (
        <div className="space-y-1 pt-1">
          <div className="flex items-center justify-between">
            <span className="t-body text-gray-700 dark:text-gray-400">
              Installed{list?.available ? ` (${packs.length})` : ''}
            </span>
            <button
              onClick={() => void refresh()}
              disabled={loading || busy !== null}
              title="Read the custom_nodes folder again"
              aria-label="Refresh the node pack list"
              className="p-1 rounded text-gray-500 hover:text-gray-300 disabled:opacity-30"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          {list?.available && (
            <p className="t-micro text-gray-600 font-mono break-all">{list.path}</p>
          )}
          {list?.available && packs.length === 0 && (
            <p className="t-micro text-gray-500">No node packs in this folder yet.</p>
          )}
          <ul className="space-y-1" data-testid="node-pack-list">
            {packs.map((pack) => {
              const noUpdate = whyNoUpdate(pack)
              const key = `${pack.inDisabledDir ? 'd/' : ''}${pack.folder}`
              return (
                <li key={key} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`t-control break-all ${pack.enabled ? 'text-gray-800 dark:text-gray-200' : 'text-gray-500'}`}>
                          {pack.name}
                        </span>
                        {!pack.enabled && (
                          <span className="t-micro rounded bg-white/[0.06] px-1 py-0.5 text-gray-500">Disabled</span>
                        )}
                        {pack.kind === 'folder' && (
                          <span className="t-micro rounded bg-white/[0.06] px-1 py-0.5 text-gray-500">No git</span>
                        )}
                        {pack.kind === 'file' && (
                          <span className="t-micro rounded bg-white/[0.06] px-1 py-0.5 text-gray-500">Single file</span>
                        )}
                      </div>
                      {pack.origin && (
                        <p className="t-micro text-gray-500 font-mono break-all">{shortOrigin(pack.origin)}</p>
                      )}
                      {pack.kind === 'git' && stateLine(pack) && (
                        <p className="t-micro text-gray-600 flex items-center gap-1">
                          <GitBranch size={9} className="shrink-0" /> {stateLine(pack)}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => update(pack)}
                        disabled={noUpdate !== null || busy !== null}
                        title={noUpdate ?? 'Pull the newest version and install its requirements'}
                        aria-label={`Update ${pack.name}`}
                        className={`${BTN_PLAIN} inline-flex items-center gap-1`}
                      >
                        <Download size={10} /> Update
                      </button>
                      <button
                        onClick={() => remove(pack)}
                        disabled={busy !== null}
                        title={armed === pack.folder ? 'Click again to move it to the trash' : 'Move to the trash'}
                        aria-label={`Remove ${pack.name}`}
                        className={armed === pack.folder
                          ? 'px-2 py-1 rounded t-micro bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors inline-flex items-center gap-1'
                          : `${BTN_PLAIN} inline-flex items-center gap-1`}
                      >
                        <Trash2 size={10} /> {armed === pack.folder ? 'Confirm' : 'Remove'}
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="t-micro text-gray-600 leading-relaxed">
            Remove moves the folder to the trash, so you can restore it from there.
          </p>
        </div>
      )}
    </div>
  )
}
