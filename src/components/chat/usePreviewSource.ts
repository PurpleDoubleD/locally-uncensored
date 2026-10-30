import { useEffect, useState } from 'react'
import { buildDocument } from '../../lib/html-preview'
import { putPreviewDocument, type PreviewSource } from '../../lib/html-preview-source'

export type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; source: PreviewSource }
  | { status: 'error'; message: string }

/**
 * The page for a model snippet, put up when the preview mounts. A component
 * that uses this only mounts on the user's click, so loading a chat runs
 * nothing. Every reload and every change of the network switch asks for a new
 * page, so a page never keeps a permission it was not shown with.
 */
export function usePreviewSource(code: string, language: string | undefined, allowNetwork: boolean, reloadKey: number): PreviewState {
  const [state, setState] = useState<{ key: string; value: PreviewState } | null>(null)
  const key = `${reloadKey}:${allowNetwork ? 1 : 0}`
  useEffect(() => {
    let live = true
    putPreviewDocument(buildDocument(code, language), allowNetwork).then(
      (source) => { if (live) setState({ key, value: { status: 'ready', source } }) },
      (err) => { if (live) setState({ key, value: { status: 'error', message: String(err instanceof Error ? err.message : err) } }) },
    )
    return () => { live = false }
    // The code is read at the moment of the click and of every reload, not
    // followed while a reply is still streaming in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state && state.key === key ? state.value : { status: 'loading' }
}
