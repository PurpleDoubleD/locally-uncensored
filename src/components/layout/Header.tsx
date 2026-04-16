import { useState, useEffect } from 'react'
import { Menu, Loader2, Power, Sun, Moon } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useCompareStore } from '../../stores/compareStore'
import { useModelStore } from '../../stores/modelStore'
import { ModelSelector } from '../models/ModelSelector'
import { UpdateBadge } from './UpdateBadge'
import { DownloadBadge } from './DownloadBadge'
import { CreateTopControls } from '../create/CreateTopControls'
import { loadModel, unloadModel, listRunningModels } from '../../api/ollama'
import { getProviderIdFromModel } from '../../api/providers'

export function Header() {
  const { currentView, toggleSidebar, setView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const isComparing = useCompareStore((s) => s.isComparing)
  const activeModel = useModelStore((s) => s.activeModel)
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'unloading'>('idle')
  const [isModelLoaded, setIsModelLoaded] = useState(false)

  // Check if active model is an Ollama model
  const isOllamaModel = activeModel ? getProviderIdFromModel(activeModel) === 'ollama' : false
  const modelToUse = activeModel?.includes('::') ? activeModel.split('::')[1] : activeModel

  const handleLoad = async () => {
    if (!modelToUse || loadingState !== 'idle') return
    setLoadingState('loading')
    try {
      await loadModel(modelToUse)
      setIsModelLoaded(true)
    } catch {}
    finally { setLoadingState('idle') }
  }

  const handleUnload = async () => {
    if (!modelToUse || loadingState !== 'idle') return
    setLoadingState('unloading')
    try {
      await unloadModel(modelToUse)
      setIsModelLoaded(false)
    } catch {}
    finally { setLoadingState('idle') }
  }

  // Check loaded state when model changes
  useEffect(() => {
    if (modelToUse && isOllamaModel) {
      listRunningModels().then(running => {
        setIsModelLoaded(running.some(r => r.includes(modelToUse.split(':')[0])))
      })
    } else {
      setIsModelLoaded(false)
    }
  }, [modelToUse, isOllamaModel])

  // Poll running state every 5s while idle
  useEffect(() => {
    if (!modelToUse || !isOllamaModel) return
    const interval = setInterval(() => {
      if (loadingState === 'idle') {
        listRunningModels().then(running => {
          setIsModelLoaded(running.some(r => r.includes(modelToUse.split(':')[0])))
        })
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [modelToUse, isOllamaModel, loadingState])

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
  }

  const textNav = (view: string, label: string) => (
    <button
      onClick={() => {
        useCompareStore.getState().setComparing(false)
        setView(view as any)
      }}
      className={`text-[0.6rem] font-medium transition-colors ${
        currentView === view && !isComparing
          ? 'text-gray-900 dark:text-white'
          : 'text-gray-500 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white'
      }`}
    >
      {label}
    </button>
  )

  return (
    <header className="h-10 flex items-center justify-between px-3 border-b border-gray-200 dark:border-white/[0.04] bg-gray-50 dark:bg-[#0e0e0e] z-20">
      {/* Left: Sidebar + Logo */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleSidebar}
          className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-800 dark:hover:text-white transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu size={15} />
        </button>
        <button
          onClick={() => {
            useChatStore.getState().setActiveConversation(null)
            useCompareStore.getState().setComparing(false)
            setView('chat')
          }}
          className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition"
        >
          <img src="/LU-monogram-bw.png" alt="" width={16} height={16} className="dark:invert-0 invert opacity-70" />
          <span className="font-semibold text-[0.7rem] tracking-wide">LUncensored</span>
        </button>
      </div>

      {/* Center: contextual controls.
          - Chat views → chat model picker + Ollama Lichtschalter
          - Create view → Image/Video mode switch + ComfyUI model picker + ComfyUI Lichtschalter
          Both layouts follow the same visual pattern so the user has a
          single familiar control surface. */}
      <div className="flex items-center gap-1">
        {currentView === 'create' ? (
          <CreateTopControls />
        ) : (
          <>
        <ModelSelector />
        {isOllamaModel && (
          (() => {
            const busy = loadingState !== 'idle'
            const onClick = () => {
              if (busy) return
              if (isModelLoaded) handleUnload()
              else handleLoad()
            }
            const title = busy
              ? (loadingState === 'loading' ? 'Loading model…' : 'Unloading model…')
              : (isModelLoaded ? 'Model loaded — click to unload' : 'Model not loaded — click to load into VRAM')
            return (
              <button
                onClick={onClick}
                disabled={busy}
                title={title}
                aria-label={title}
                className={`relative flex items-center h-[18px] w-[34px] rounded-full transition-colors duration-200 ${
                  busy
                    ? 'bg-amber-500/25 border border-amber-400/40'
                    : isModelLoaded
                      ? 'bg-green-500/25 border border-green-400/50'
                      : 'bg-red-500/20 border border-red-400/40 hover:bg-red-500/30'
                }`}
              >
                <span
                  className={`absolute top-[1px] flex items-center justify-center w-[14px] h-[14px] rounded-full shadow-sm transition-all duration-200 ${
                    busy
                      ? 'left-[9px] bg-amber-400'
                      : isModelLoaded
                        ? 'left-[18px] bg-green-400'
                        : 'left-[1px] bg-red-400'
                  }`}
                >
                  {busy ? (
                    <Loader2 size={9} className="animate-spin text-gray-900" />
                  ) : (
                    <Power size={9} className="text-gray-900" />
                  )}
                </span>
              </button>
            )
          })()
        )}
          </>
        )}
      </div>

      {/* Right: text nav + icon utilities */}
      <div className="flex items-center gap-2.5">
        <DownloadBadge />
        <button
          onClick={toggleTheme}
          className="p-1 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          title={settings.theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          {settings.theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {textNav('chat', 'Chat')}
        {textNav('create', 'Create')}
        <button
          onClick={() => { useCompareStore.getState().setComparing(true); setView('chat') }}
          className={`text-[0.6rem] font-medium transition-colors ${
            isComparing
              ? 'text-gray-900 dark:text-white'
              : 'text-gray-500 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          Compare
        </button>
        {textNav('benchmark', 'Benchmark')}
        {textNav('models', 'Models')}
        {textNav('settings', 'Settings')}
        <UpdateBadge />
      </div>
    </header>
  )
}
