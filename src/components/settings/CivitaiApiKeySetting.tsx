/**
 * The CivitAI API key field.
 *
 * goonerforporn, Discord #bug-reports 2026-08-28: "the field for the CivitAI
 * API key is gone from the UI". He was right, and he had already checked
 * Settings, Models/Discover and the workflow finder before writing. The store
 * held `civitaiApiKey`, `setCivitaiApiKey` existed, the changelog mentioned the
 * key. And no component in the app ever called the setter, so there was no way
 * to put a key in. Search read the value (empty), downloads read it (empty),
 * and CivitAI answered with a bare 400 nobody could act on.
 *
 * Masked on purpose: this is a credential, and a settings page is a screen
 * people share in support threads. The value itself goes into the OS vault
 * where there is one (workflowStore.hydrateCivitaiApiKey), the same place the
 * provider keys and the HuggingFace token live.
 */
import { useEffect, useState } from 'react'
import { KeyRound, Check } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'
import { openExternal } from '../../api/backend'

/** Where CivitAI issues the key. Account page, API Keys section. */
export const CIVITAI_KEY_PAGE = 'https://civitai.com/user/account'

export function CivitaiApiKeySetting() {
  const apiKey = useWorkflowStore((s) => s.civitaiApiKey)
  const setApiKey = useWorkflowStore((s) => s.setCivitaiApiKey)
  const [draft, setDraft] = useState(apiKey)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setDraft(apiKey) }, [apiKey])

  function save() {
    const next = draft.trim()
    setApiKey(next)
    setDraft(next)
    setSaved(true)
  }

  return (
    <div className="space-y-2 py-1">
      <div className="flex items-center gap-1.5">
        <KeyRound size={12} className="text-gray-500" />
        <span className="text-[0.7rem] text-gray-800 dark:text-gray-200">CivitAI API key</span>
      </div>
      <div className="text-[0.6rem] text-gray-500 leading-relaxed">
        Used for the CivitAI search on the Models page and for the downloads it starts. Most CivitAI
        downloads are refused without a key, which is the HTTP 400 or 401 you see on a download that
        never begins. Create one on your CivitAI account page under API Keys. It goes into your
        system credential store where the OS has one, stays on this machine, and is sent to CivitAI
        only.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setSaved(false) }}
          onBlur={save}
          placeholder="(none)"
          spellCheck={false}
          autoComplete="off"
          aria-label="CivitAI API key"
          className="flex-1 min-w-0 px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:border-white/20"
        />
        <button
          onClick={save}
          className="px-2.5 py-1 rounded-md text-[0.6rem] font-medium inline-flex items-center gap-1 bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
        >
          {saved && <Check size={11} />}
          {saved ? 'Saved' : 'Save'}
        </button>
        {apiKey && (
          <button
            onClick={() => { setDraft(''); setApiKey(''); setSaved(false) }}
            className="px-2.5 py-1 rounded-md text-[0.6rem] text-gray-500 hover:text-red-400 transition-colors"
          >
            Remove
          </button>
        )}
      </div>
      <button
        onClick={() => { void openExternal(CIVITAI_KEY_PAGE) }}
        className="text-[0.6rem] text-purple-500 hover:text-purple-400 transition-colors"
      >
        Get a CivitAI API key
      </button>
    </div>
  )
}
