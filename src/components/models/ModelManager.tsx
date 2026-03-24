import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, ArrowLeft, RefreshCw, MessageSquare, Image, Video, Layers } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useUIStore } from '../../stores/uiStore'
import { ModelCard } from './ModelCard'
import { PullModelDialog } from './PullModelDialog'
import { DiscoverModels } from './DiscoverModels'
import { Modal } from '../ui/Modal'
import { GlowButton } from '../ui/GlowButton'
import { showModel } from '../../api/ollama'
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
  const [pullOpen, setPullOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [modelInfo, setModelInfo] = useState<any>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [tab, setTab] = useState<'installed' | 'discover'>('installed')

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

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

  const filteredModels = categoryFilter === 'all'
    ? models
    : models.filter((m: AIModel) => m.type === categoryFilter)

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setView('chat')}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Model Manager</h1>
          </div>
          <div className="flex items-center gap-2">
            <GlowButton variant="secondary" onClick={fetchModels}>
              <RefreshCw size={16} />
            </GlowButton>
            <GlowButton onClick={() => setPullOpen(true)} className="flex items-center gap-2">
              <Download size={16} /> Pull Model
            </GlowButton>
          </div>
        </div>

        {/* Main tabs: Installed / Discover */}
        <div className="flex gap-1 mb-4 p-1 bg-gray-100 dark:bg-white/5 rounded-lg w-fit">
          <button
            onClick={() => setTab('installed')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === 'installed'
                ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white'
            }`}
          >
            Installed ({models.length})
          </button>
          <button
            onClick={() => setTab('discover')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
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
          <div className="flex gap-0.5 mb-6 p-1 bg-gray-100 dark:bg-white/5 rounded-lg w-fit">
            {CATEGORY_TABS.map((catTab) => {
              const Icon = catTab.icon
              const count = catTab.key === 'all' ? models.length : models.filter((m) => m.type === catTab.key).length
              return (
                <button
                  key={catTab.key}
                  onClick={() => setCategoryFilter(catTab.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    categoryFilter === catTab.key
                      ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-white/5'
                  }`}
                >
                  <Icon size={12} />
                  {catTab.label} ({count})
                </button>
              )
            })}
          </div>
        )}

        {tab === 'installed' && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredModels.map((model, i) => (
                <motion.div
                  key={model.name}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <ModelCard
                    model={model}
                    isActive={model.name === activeModel}
                    onSelect={() => setActiveModel(model.name)}
                    onDelete={() => setConfirmDelete(model.name)}
                    onInfo={() => handleInfo(model.name)}
                  />
                </motion.div>
              ))}
            </div>

            {filteredModels.length === 0 && (
              <div className="text-center py-16">
                <p className="text-gray-500 mb-4">
                  {categoryFilter === 'all'
                    ? 'No models installed'
                    : `No ${categoryFilter === 'text' ? 'Text' : categoryFilter === 'image' ? 'Image' : 'Video'} models installed`}
                </p>
                <GlowButton onClick={() => setTab('discover')}>Discover uncensored models</GlowButton>
              </div>
            )}
          </>
        )}

        {tab === 'discover' && <DiscoverModels />}
      </div>

      <PullModelDialog open={pullOpen} onClose={() => setPullOpen(false)} />

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Model">
        <p className="text-gray-600 dark:text-gray-300 mb-4">
          Are you sure you want to delete <span className="text-gray-900 dark:text-white font-mono">{confirmDelete}</span>?
        </p>
        <div className="flex gap-3">
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
          <pre className="text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-black/30 rounded-lg p-4 overflow-auto max-h-96 scrollbar-thin font-mono">
            {JSON.stringify(modelInfo, null, 2)}
          </pre>
        )}
      </Modal>
    </div>
  )
}
