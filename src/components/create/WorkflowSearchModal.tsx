import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, Upload, Loader2, AlertCircle, Key, Eye, EyeOff } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { Modal } from '../ui/Modal'
import { WorkflowCard } from './WorkflowCard'
import { useWorkflowStore } from '../../stores/workflowStore'
import {
  searchWorkflows,
  fetchWorkflowFromUrl,
  validateWorkflowJson,
  parseImportedWorkflow,
  extractSearchTerms,
} from '../../api/workflows'
import type { WorkflowSearchResult, WorkflowTemplate } from '../../types/workflows'
import type { ModelType } from '../../api/comfyui'

interface Props {
  open: boolean
  onClose: () => void
  modelName: string
  modelType: ModelType
}

type TabId = 'discover' | 'templates' | 'import'

const TABS: { id: TabId; label: string }[] = [
  { id: 'templates', label: 'Templates' },
  { id: 'discover', label: 'Discover' },
  { id: 'import', label: 'Import' },
]

export function WorkflowSearchModal({ open, onClose, modelName, modelType }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('discover')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkflowSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importUrl, setImportUrl] = useState('')
  const [importJson, setImportJson] = useState('')
  const [importName, setImportName] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const initialSearchDone = useRef(false)
  const templatesCached = useRef<WorkflowSearchResult[] | null>(null)

  const { installedWorkflows, installWorkflow, assignToModelName, civitaiApiKey, setCivitaiApiKey } = useWorkflowStore()
  const [showApiKey, setShowApiKey] = useState(false)
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [showApiKeyWarning, setShowApiKeyWarning] = useState(false)
  const [installStatus, setInstallStatus] = useState<string | null>(null)

  // Reset state and load templates when modal opens
  useEffect(() => {
    if (open) {
      const terms = extractSearchTerms(modelName, modelType)
      setQuery(terms)
      setError(null)
      setActiveTab('templates')
      initialSearchDone.current = false
      // Load templates immediately, sorted by compatibility (matching first)
      searchWorkflows('', 'templates' as any).then(r => {
        const sorted = [...r].sort((a, b) => {
          const aMatch = a.modelTypes.includes(modelType) ? -1 : 1
          const bMatch = b.modelTypes.includes(modelType) ? -1 : 1
          return aMatch - bMatch
        })
        templatesCached.current = sorted
        setResults(sorted)
      })
    }
  }, [open, modelName, modelType])

  const performSearch = async (source: TabId, searchQuery: string) => {
    if (source === 'import') return
    setLoading(true)
    setError(null)
    try {
      const searchSource = source === 'discover' ? 'civitai' : 'templates'
      const r = await searchWorkflows(searchQuery, searchSource as any)
      setResults(r)
      if (r.length === 0) setError('No workflows found. Try different search terms.')
    } catch (err) {
      setError(`Search failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    if (activeTab !== 'import') {
      performSearch(activeTab, activeTab === 'templates' ? '' : query)
    }
  }

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    setError(null)

    if (tab === 'templates') {
      // Load templates synchronously — they're local data
      if (templatesCached.current) {
        setResults(templatesCached.current)
      } else {
        const templates = searchWorkflows('', 'templates' as any)
        // searchWorkflows returns a Promise, but templates are sync
        templates.then(r => {
          templatesCached.current = r
          setResults(r)
        })
      }
    } else if (tab === 'discover') {
      // Restore discover results or clear
      setResults([])
      if (query) {
        performSearch('discover', query)
      }
    } else {
      setResults([])
    }
  }

  const handleInstallResult = async (result: WorkflowSearchResult) => {
    if (!result.downloadUrl && !result.rawWorkflow) {
      setError('No download link available. Try the Import tab with the workflow page URL.')
      return
    }

    if (!result.rawWorkflow && result.source === 'civitai' && !civitaiApiKey) {
      setShowApiKeyWarning(true)
      return
    }

    setLoading(true)
    setError(null)
    setInstallStatus('Downloading workflow...')
    try {
      let workflow: Record<string, any>
      if (result.rawWorkflow) {
        workflow = result.rawWorkflow
      } else {
        workflow = await fetchWorkflowFromUrl(result.downloadUrl!, civitaiApiKey || undefined)
      }

      setInstallStatus('Processing...')
      const parsed = parseImportedWorkflow(
        result.name,
        workflow,
        result.source,
        result.sourceUrl,
        result.description,
      )

      const template: WorkflowTemplate = {
        ...parsed,
        id: uuid(),
        installedAt: Date.now(),
        thumbnailUrl: result.thumbnailUrl,
      }

      installWorkflow(template)
      assignToModelName(modelName, template.id)
      setInstallStatus(null)
    } catch (err) {
      setError(`Install failed: ${err instanceof Error ? err.message : String(err)}`)
      setInstallStatus(null)
    } finally {
      setLoading(false)
    }
  }

  const handleImportUrl = async () => {
    if (!importUrl.trim()) return
    setImportLoading(true)
    setError(null)
    try {
      const workflow = await fetchWorkflowFromUrl(importUrl.trim())
      const name = importName.trim() || new URL(importUrl).pathname.split('/').pop()?.replace('.json', '') || 'Imported Workflow'
      const parsed = parseImportedWorkflow(name, workflow, 'manual', importUrl)
      const template: WorkflowTemplate = {
        ...parsed,
        id: uuid(),
        installedAt: Date.now(),
      }
      installWorkflow(template)
      assignToModelName(modelName, template.id)
      setImportUrl('')
      setImportName('')
    } catch (err) {
      setError(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImportLoading(false)
    }
  }

  const handleImportJson = () => {
    if (!importJson.trim()) return
    setError(null)
    try {
      const json = JSON.parse(importJson.trim())
      if (!validateWorkflowJson(json)) {
        setError('Invalid workflow format. Expected ComfyUI API format with nodes (class_type).')
        return
      }
      const name = importName.trim() || 'Imported Workflow'
      const parsed = parseImportedWorkflow(name, json, 'manual')
      const template: WorkflowTemplate = {
        ...parsed,
        id: uuid(),
        installedAt: Date.now(),
      }
      installWorkflow(template)
      assignToModelName(modelName, template.id)
      setImportJson('')
      setImportName('')
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('Invalid JSON. Please paste valid JSON.')
      } else {
        setError(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const findInstalledWorkflow = (result: WorkflowSearchResult) =>
    installedWorkflows.find(w => w.name === result.name && w.source === result.source)

  const isInstalledResult = (result: WorkflowSearchResult) => !!findInstalledWorkflow(result)

  const isActiveResult = (result: WorkflowSearchResult) => {
    const installed = findInstalledWorkflow(result)
    if (!installed) return false
    const activeWf = useWorkflowStore.getState().getWorkflowForModel(modelName, modelType)
    return activeWf?.id === installed.id
  }

  const handleInstallOrUse = async (result: WorkflowSearchResult) => {
    const existing = findInstalledWorkflow(result)
    if (existing) {
      // Already installed — just assign to current model
      assignToModelName(modelName, existing.id)
      return
    }
    // Not installed — download and install
    handleInstallResult(result)
  }

  const inputClass = 'w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm focus:outline-none focus:border-white/20 placeholder-gray-500'

  return (
    <Modal open={open} onClose={onClose} title="Workflow Finder">
      <div className="relative">
      <div className={`space-y-4 max-h-[70vh] flex flex-col transition-all duration-200 ${showApiKeyWarning ? 'blur-sm opacity-40 pointer-events-none' : ''}`}>
        {/* Tab Bar */}
        <div className="flex gap-1 p-1 rounded-lg bg-white/5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-white/15 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search bar (Discover tab) */}
        {activeTab === 'discover' && (
          <>
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="e.g. flux workflow, sdxl inpainting..."
              className={`${inputClass} flex-1`}
            />
            <button
              onClick={handleSearch}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
            <button
              onClick={() => setShowApiKeyInput(!showApiKeyInput)}
              className={`p-2 rounded-lg border transition-colors ${
                civitaiApiKey
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-white/5 border-white/10 text-gray-500 hover:text-white'
              }`}
              title={civitaiApiKey ? 'API key set' : 'Add CivitAI API key (required for downloads)'}
              aria-label="CivitAI API key"
            >
              <Key size={16} />
            </button>
          </div>

          {/* API Key Input */}
          {showApiKeyInput && (
            <div className="flex gap-2 items-center">
              <div className="relative flex-1">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={civitaiApiKey}
                  onChange={(e) => setCivitaiApiKey(e.target.value)}
                  placeholder="CivitAI API key (civitai.com/user/account)"
                  className={`${inputClass} pr-8`}
                />
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  aria-label="Toggle API key visibility"
                >
                  {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {civitaiApiKey && (
                <span className="text-[10px] text-emerald-400 flex-shrink-0">Saved</span>
              )}
            </div>
          )}
          </>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Content */}
        {activeTab === 'import' ? (
          <div className="space-y-3 overflow-y-auto flex-1">
            <div>
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1 block">Name</label>
              <input
                type="text"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                placeholder="Workflow name (optional)"
                className={inputClass}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1 block">URL Import</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://example.com/workflow.json"
                  className={`${inputClass} flex-1`}
                />
                <button
                  onClick={handleImportUrl}
                  disabled={importLoading || !importUrl.trim()}
                  className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors disabled:opacity-50"
                >
                  {importLoading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1 block">Paste JSON</label>
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{"1": {"class_type": "CheckpointLoaderSimple", ...}}'
                className={`${inputClass} h-32 resize-none font-mono text-xs`}
              />
              <button
                onClick={handleImportJson}
                disabled={!importJson.trim()}
                className="mt-2 w-full px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm transition-colors disabled:opacity-50"
              >
                Import
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
            {loading && (
              <div className="flex items-center justify-center py-4 text-gray-400 text-sm">
                <Loader2 size={16} className="animate-spin mr-2" />
                {installStatus || 'Searching...'}
              </div>
            )}
            {!loading && results.length === 0 && !error && activeTab === 'discover' && (
              <div className="text-center py-8 text-gray-500 text-sm">
                Search for ComfyUI workflows
              </div>
            )}
            {results.map((r, i) => (
              <WorkflowCard
                key={`${r.source}-${r.sourceUrl}-${i}`}
                result={r}
                isInstalled={isInstalledResult(r)}
                isActive={isActiveResult(r)}
                currentModelType={modelType}
                onInstall={handleInstallOrUse}
              />
            ))}
          </div>
        )}
      </div>

      {/* API Key Warning Overlay */}
      {showApiKeyWarning && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/60 rounded-2xl" onClick={() => setShowApiKeyWarning(false)} />
          <div className="relative z-10 bg-neutral-900 border border-white/15 rounded-xl p-5 max-w-sm w-full space-y-4 shadow-2xl">
            <div className="flex items-center gap-2">
              <Key size={18} className="text-amber-400" />
              <h3 className="text-sm font-semibold text-white">CivitAI API Key Required</h3>
            </div>
            <p className="text-xs text-gray-300 leading-relaxed">
              CivitAI requires an API key to download workflows. You can create one for free in about a minute:
            </p>
            <a
              href="https://civitai.com/user/account"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 text-white text-sm font-medium text-center transition-colors"
            >
              Get Free API Key on CivitAI
            </a>
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1 block">Paste your key here</label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={civitaiApiKey}
                  onChange={(e) => setCivitaiApiKey(e.target.value)}
                  placeholder="Your CivitAI API key"
                  className={`${inputClass} pr-8`}
                  autoFocus
                />
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  aria-label="Toggle API key visibility"
                >
                  {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowApiKeyWarning(false)}
                className="flex-1 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-gray-300 text-xs transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (civitaiApiKey) {
                    setShowApiKeyWarning(false)
                    setShowApiKeyInput(false)
                  }
                }}
                disabled={!civitaiApiKey}
                className="flex-1 px-3 py-2 rounded-lg bg-white hover:bg-gray-200 disabled:opacity-40 text-gray-900 text-xs font-medium transition-colors"
              >
                Save & Continue
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </Modal>
  )
}
