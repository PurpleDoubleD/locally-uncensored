import { useState, useEffect, useRef } from 'react'
import { FolderOpen, Folder, FileText, ArrowLeft, RefreshCw } from 'lucide-react'
import { useCodexStore } from '../../stores/codexStore'
import { toolRegistry } from '../../api/mcp'
import { isTauri } from '../../api/backend'
import type { FileTreeNode } from '../../types/codex'

export function FileTree() {
  const workingDirectory = useCodexStore((s) => s.workingDirectory)
  const fileTree = useCodexStore((s) => s.fileTree)
  const fileTreeVersion = useCodexStore((s) => s.fileTreeVersion)
  const setFileTree = useCodexStore((s) => s.setFileTree)
  const setWorkingDirectory = useCodexStore((s) => s.setWorkingDirectory)
  const [loading, setLoading] = useState(false)

  const loadDirectory = async (dir: string) => {
    if (!dir.trim()) return
    setLoading(true)
    try {
      const result = await toolRegistry.execute('file_list', { path: dir })
      const lines = result.split('\n').filter(Boolean)
      const nodes: FileTreeNode[] = lines.map(line => {
        const isDir = line.startsWith('[DIR]')
        const parts = line.replace('[DIR] ', '').split('  ')
        const nameSize = parts[0]?.trim() || ''
        const path = parts[1]?.trim() || ''
        const name = nameSize.split(' (')[0]?.trim() || ''
        return { name, path, isDirectory: isDir }
      }).filter(n => n.name)

      setFileTree(nodes)
      setWorkingDirectory(dir)
    } catch {
      setFileTree([])
    } finally {
      setLoading(false)
    }
  }

  // Go to parent directory
  const goBack = () => {
    if (!workingDirectory) return
    const normalized = workingDirectory.replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    if (parts.length <= 1) {
      loadDirectory(parts[0] + '/')
    } else {
      const parent = parts.slice(0, -1).join('/')
      loadDirectory(parent)
    }
  }

  // Native folder picker — Tauri uses Rust dialog, dev mode uses prompt fallback
  const handlePickClick = async () => {
    if (isTauri()) {
      try {
        const invoke = (await import('@tauri-apps/api/core')).invoke
        const selected = await invoke<string | null>('pick_folder', {
          defaultPath: workingDirectory || undefined,
        })
        if (selected) loadDirectory(selected)
      } catch {
        // Fallback if invoke fails
        const dir = window.prompt('Enter folder path:', workingDirectory || 'C:\\Users')
        if (dir) loadDirectory(dir)
      }
    } else {
      const dir = window.prompt('Enter folder path:', workingDirectory || 'C:\\Users')
      if (dir) loadDirectory(dir)
    }
  }

  useEffect(() => {
    if (workingDirectory && fileTree.length === 0) {
      loadDirectory(workingDirectory)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-refresh when Codex writes / executes in the working directory.
  // fileTreeVersion is bumped by codexStore.addEvent for file_change /
  // terminal_output events. Skip the first mount (already handled above).
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    if (workingDirectory) loadDirectory(workingDirectory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTreeVersion])

  return (
    <div className="h-full flex flex-col border-l border-gray-200 dark:border-white/[0.04] bg-gray-50 dark:bg-white/[0.01]">
      {/* Directory picker — click to open native dialog */}
      <div className="p-1.5 border-b border-gray-200 dark:border-white/[0.04]">
        <button
          onClick={handlePickClick}
          className="w-full flex items-center gap-1 px-1.5 py-1 rounded bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 transition-colors text-left"
        >
          <FolderOpen size={10} className="text-gray-500 shrink-0" />
          {workingDirectory ? (
            <span className="text-[0.5rem] text-gray-700 dark:text-gray-300 font-mono truncate flex-1">{workingDirectory}</span>
          ) : (
            <span className="text-[0.5rem] text-gray-400 dark:text-gray-600 flex-1">Select folder...</span>
          )}
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-1">
        {loading ? (
          <p className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2">Loading...</p>
        ) : fileTree.length === 0 ? (
          <p className="text-[0.5rem] text-gray-400 dark:text-gray-600 px-1 py-2">
            {workingDirectory ? 'Empty directory' : 'Click above to set a folder'}
          </p>
        ) : (
          fileTree.map((node, i) => (
            <button
              key={i}
              onClick={() => node.isDirectory && loadDirectory(node.path)}
              className={`flex items-center gap-1 w-full px-1 py-[2px] text-[0.5rem] rounded transition-colors text-left ${
                node.isDirectory
                  ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer'
                  : 'text-gray-400 dark:text-gray-600'
              }`}
            >
              {node.isDirectory ? (
                <Folder size={8} className="text-gray-500 shrink-0" />
              ) : (
                <FileText size={8} className="text-gray-400 dark:text-gray-600 shrink-0" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
          ))
        )}
      </div>

      {/* Bottom nav */}
      <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-t border-gray-200 dark:border-white/[0.04]">
        <button
          onClick={goBack}
          disabled={!workingDirectory}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 disabled:opacity-30 transition-colors"
          title="Parent directory"
        >
          <ArrowLeft size={10} />
        </button>
        <button
          onClick={() => workingDirectory && loadDirectory(workingDirectory)}
          disabled={!workingDirectory}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 dark:text-gray-600 disabled:opacity-30 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={10} />
        </button>
      </div>
    </div>
  )
}
