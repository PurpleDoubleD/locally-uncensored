import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, ArrowLeft, RefreshCw, MessageSquare, Image, Video, Layers, AlertTriangle, FolderOpen } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useUIStore } from '../../stores/uiStore'
import { useProviderStore } from '../../stores/providerStore'
import { ModelCard } from './ModelCard'
import { PullModelDialog } from './PullModelDialog'
import { DiscoverModels } from './DiscoverModels'
import { Modal } from '../ui/Modal'
import { GlowButton } from '../ui/GlowButton'
import { showModel } from '../../api/ollama'
import { backendCall, isTauri } from '../../api/backend'
import type { ModelCategory, AIModel } from '../../types/models'

const CATEGORY_TABS: { key: ModelCategory; label: string; icon: typeof Layers }[] = [
  { key: 'all', label: 'All', icon: Layers },
  { key: 'text', label: 'Text', icon: MessageSquare },
  { key: 'image', label: 'Image', icon: Image },
  { key: 'video', label: 'Video', icon: Video },
]

export function ModelManager() {
  const { models, activeModel, setActiveModel, fetchModels, removeModel, categoryFilter, setCategoryFilter } = useModels()
  const { setView } = useUIStore()
  const ollamaEnabled = useProviderStore(s => s.providers.ollama.enabled)
  const [pullOpen, setPullOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [modelInfo, setModelInfo] = useState<any>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [tab, setTab] = useState<'installed' | 'discover'>('installed')
  const [comfyStatus, setComfyStatus] = useState<{ running: boolean; found: boolean; path: string | null } | null>(null)
  const [comfyPathInput, setComfyPathInput] = useState('')
  const [comfyPathError, setComfyPathError] = useState('')
  const [comfyPathSaving, setComfyPathSaving] = useState(false)

  useEffect(() => {
    fetchModels()
    backendCall('comfyui_status').then(setComfyStatus).catch(() => {})
  }, [fetchModels])

  const handleSetComfyPath = async () => {
    if (!comfyPathInput.trim()) { setComfyPathError('Enter a path'); return }
    setComfyPathSaving(true)
    setComfyPathError('')
    try {
      const data = await backendCall('set_comfyui_path', { path: comfyPathInput.trim() })
      if (data.status === 'saved' || data.status === 'ok') {
        setComfyStatus(prev => prev ? { ...prev, found: true, path: comfyPathInput.trim() } : null)
        setComfyPathInput('')
        fetchModels()
      } else {
        setComfyPathError(data.error || 'Invalid path')
      }
    } catch (err) {
      setComfyPathError(String(err))
    }
    setComfyPathSaving(false)
  }

  const handleInfo = async (name: string) => {
    try {
      const info = await showModel(name)
      setModelInfo({ name, ...info })
      setInfoOpen(true)
    } catch {
      // ignore
    }
  }

  const handleDelete = async (name: string) => {
    await removeModel(name)
    setConfirmDelete(null)
  }

  const filteredModels = models.filter((m: AIModel) => {
    if (categoryFilter !== 'all' && m.type !== categoryFilter) return false
    return true
  })

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView('chat')}
              className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="text-[0.8rem] font-semibold text-gray-800 dark:text-gray-200">Model Manager</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={fetchModels} className="p-1.5 rounded-lg hover:bg-white/10 text-gray-500 hover:text-white transition-colors">
              <RefreshCw size={13} />
            </button>
            {ollamaEnabled && (
              <button
                onClick={() => setPullOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 hover:bg-white/10 transition-colors"
              >
                <Download size={12} /> Pull Model
              </button>
            )}
          </div>
        </div>

        {/* ComfyUI path warning */}
        {comfyStatus && !comfyStatus.found && !comfyStatus.path && (
          <div className="mb-3 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20">
            <div className="flex items-start gap-2 mb-1.5">
              <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-[0.7rem] font-medium text-amber-800 dark:text-amber-300">ComfyUI not found</p>
                <p className="text-[0.6rem] text-amber-600 dark:text-amber-400 mt-0.5">Image/Video model downloads need the ComfyUI path.</p>
              </div>
            </div>
            <div className="flex gap-1.5 mt-1.5">
              <div className="flex-1 flex items-center gap-1.5">
                <FolderOpen size={12} className="text-amber-500 shrink-0" />
                <input
                  value={comfyPathInput}
                  onChange={(e) => { setComfyPathInput(e.target.value); setComfyPathError('') }}
                  placeholder="C:\Users\you\ComfyUI"
                  className="flex-1 px-2 py-1 rounded bg-white dark:bg-black/20 border border-amber-300 dark:border-amber-500/30 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none"
                />
              </div>
              <button
                onClick={handleSetComfyPath}
                disabled={comfyPathSaving}
                className="px-2 py-1 rounded bg-amber-500 hover:bg-amber-600 text-white text-[0.6rem] font-medium transition-colors disabled:opacity-50"
              >
                {comfyPathSaving ? '...' : 'Set Path'}
              </button>
            </div>
            {comfyPathError && <p className="text-[0.55rem] text-red-500 mt-1">{comfyPathError}</p>}
          </div>
        )}

        {comfyStatus?.path && (
          <p className="text-[0.55rem] text-gray-500 mb-3 font-mono">ComfyUI: {comfyStatus.path}</p>
        )}

        {/* Main tabs: Installed / Discover */}
        <div className="flex gap-0.5 mb-3 p-0.5 bg-gray-100 dark:bg-white/5 rounded-lg w-fit">
          <button
            onClick={() => setTab('installed')}
            className={`px-3 py-1 rounded-md text-[0.65rem] font-medium transition-all ${
              tab === 'installed'
                ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'
            }`}
          >
            Installed ({models.length})
          </button>
          <button
            onClick={() => setTab('discover')}
            className={`px-3 py-1 rounded-md text-[0.65rem] font-medium transition-all ${
              tab === 'discover'
                ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'
            }`}
          >
            Discover Uncensored
          </button>
        </div>

        {/* Category filter tabs */}
        {tab === 'installed' && (
          <div className="flex gap-0.5 mb-4 p-0.5 bg-gray-100 dark:bg-white/5 rounded-lg w-fit">
            {CATEGORY_TABS.map((catTab) => {
              const Icon = catTab.icon
              const count = catTab.key === 'all' ? models.length : models.filter((m) => m.type === catTab.key).length
              return (
                <button
                  key={catTab.key}
                  onClick={() => setCategoryFilter(catTab.key)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md text-[0.6rem] font-medium transition-all ${
                    categoryFilter === catTab.key
                      ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <Icon size={10} />
                  {catTab.label} ({count})
                </button>
              )
            })}
          </div>
        )}

        {tab === 'installed' && (
          <>
            <div className="space-y-0.5">
              {filteredModels.map((model, i) => (
                <motion.div
                  key={model.name}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.02 }}
                >
                  <ModelCard
                    model={model}
                    isActive={model.name === activeModel}
                    onSelect={() => setActiveModel(model.name)}
                    onDelete={() => setConfirmDelete(model.name)}
                    onInfo={() => handleInfo(model.name)}
                    canDelete={ollamaEnabled && model.type === 'text' && (!('provider' in model) || model.provider === 'ollama')}
                  />
                </motion.div>
              ))}
            </div>

            {filteredModels.length === 0 && (
              <div className="text-center py-10">
                <p className="text-[0.7rem] text-gray-500 mb-3">
                  {categoryFilter === 'all'
                    ? 'No models installed'
                    : `No ${categoryFilter === 'text' ? 'Text' : categoryFilter === 'image' ? 'Image' : 'Video'} models installed`}
                </p>
                <button
                  onClick={() => setTab('discover')}
                  className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[0.65rem] text-gray-300 hover:bg-white/10 transition-colors"
                >
                  Discover uncensored models
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'discover' && (
          <>
            <div className="flex gap-0.5 mb-4 p-0.5 bg-gray-100 dark:bg-white/5 rounded-lg w-fit">
              {CATEGORY_TABS.filter(t => t.key !== 'all').map((catTab) => {
                const Icon = catTab.icon
                return (
                  <button
                    key={catTab.key}
                    onClick={() => setCategoryFilter(catTab.key)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-[0.6rem] font-medium transition-all ${
                      categoryFilter === catTab.key
                        ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-white/5'
                    }`}
                  >
                    <Icon size={10} />
                    {catTab.label}
                  </button>
                )
              })}
            </div>
            <DiscoverModels category={categoryFilter === 'all' ? 'text' : categoryFilter} />
          </>
        )}
      </div>

      <PullModelDialog open={pullOpen} onClose={() => setPullOpen(false)} />

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Model">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-300 mb-3">
          Are you sure you want to delete <span className="text-gray-900 dark:text-white font-mono">{confirmDelete}</span>?
        </p>
        <div className="flex gap-2">
          <GlowButton variant="secondary" onClick={() => setConfirmDelete(null)} className="flex-1">
            Cancel
          </GlowButton>
          <GlowButton variant="danger" onClick={() => confirmDelete && handleDelete(confirmDelete)} className="flex-1">
            Delete
          </GlowButton>
        </div>
      </Modal>

      <Modal open={infoOpen} onClose={() => setInfoOpen(false)} title={modelInfo?.name || 'Model Info'}>
        {modelInfo && (
          <pre className="text-[0.6rem] text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-black/30 rounded-lg p-3 overflow-auto max-h-80 scrollbar-thin font-mono">
            {JSON.stringify(modelInfo, null, 2)}
          </pre>
        )}
      </Modal>
    </div>
  )
}
