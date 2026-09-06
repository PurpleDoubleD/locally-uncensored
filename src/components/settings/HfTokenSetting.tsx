/**
 * The Hugging Face token field, on every platform.
 *
 * It used to live only inside the Apple MLX media panel, so a Windows or Linux
 * user had no place to put a token at all. Meanwhile the GGUF downloader in
 * src-tauri/src/commands/download.rs sent none, and a gated repository
 * (OrcaRouter's own Qwen 3.8 27B Uncensored GGUF repo answers HTTP 401 to
 * everyone without an accepted licence) ended in "trying again cannot help".
 * Now the token is sent to huggingface.co on every model download, the 401
 * text names this field, and this field exists wherever the app runs.
 *
 * Masked, like the CivitAI key next to it: a settings page is a screen people
 * paste into support threads. The keychain is the store of record; Rust holds
 * the token in memory only, so saving pushes it down at once and
 * lib/rust-boot-sync pushes it again on every start.
 */
import { useEffect, useState } from 'react'
import { KeyRound, Check } from 'lucide-react'
import { secretGet, secretSet, openExternal } from '../../api/backend'
import { applyHfToken, HF_TOKEN_ACCOUNT } from '../../api/mlx-image'

/** Where Hugging Face issues tokens. A read token is enough. */
export const HF_TOKEN_PAGE = 'https://huggingface.co/settings/tokens'

export function HfTokenSetting() {
  const [draft, setDraft] = useState('')
  const [stored, setStored] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const value = await secretGet(HF_TOKEN_ACCOUNT).catch(() => null)
      if (!value) return
      setDraft(value)
      setStored(true)
    })()
  }, [])

  async function commit(value: string) {
    setError(null)
    try {
      await secretSet(HF_TOKEN_ACCOUNT, value)
      await applyHfToken(value)
      setDraft(value)
      setStored(value.length > 0)
      setSaved(value.length > 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-2 py-1">
      <div className="flex items-center gap-1.5">
        <KeyRound size={12} className="text-gray-500" />
        <span className="t-micro text-gray-800 dark:text-gray-200">Hugging Face token</span>
        <span className="t-micro text-gray-500">optional</span>
      </div>
      <div className="t-micro text-gray-500 leading-relaxed">
        Sent to huggingface.co with every model download, and nowhere else. Without it downloads go out
        anonymous, which the hub throttles, and a gated repository (one whose licence you have to accept
        on its page) refuses the download with HTTP 401. A free read token is enough. It goes into your
        system credential store where the OS has one and stays on this machine.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setSaved(false) }}
          placeholder="hf_..."
          spellCheck={false}
          autoComplete="off"
          aria-label="Hugging Face token"
          className="flex-1 min-w-0 px-2 py-1 rounded bg-transparent border border-white/8 t-micro text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:border-white/20"
        />
        <button
          onClick={() => { void commit(draft.trim()) }}
          className="px-2.5 py-1 rounded-md t-micro font-medium inline-flex items-center gap-1 bg-white dark:bg-white/10 text-gray-800 dark:text-white hover:bg-gray-100 dark:hover:bg-white/15 border border-gray-200 dark:border-white/15 transition-colors"
        >
          {saved && <Check size={11} />}
          {saved ? 'Saved' : 'Save'}
        </button>
        {stored && (
          <button
            onClick={() => { void commit('') }}
            className="px-2.5 py-1 rounded-md t-micro text-gray-500 hover:text-red-400 transition-colors"
          >
            Remove
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="t-micro text-red-400">{error}</div>
      )}
      <button
        onClick={() => { void openExternal(HF_TOKEN_PAGE) }}
        className="t-micro text-purple-500 hover:text-purple-400 transition-colors"
      >
        Get a Hugging Face token
      </button>
    </div>
  )
}
