/**
 * Where a chat HTML preview gets its page from (B29, 3.0.9).
 *
 * In the app the page is put up on the `luprev` scheme (src-tauri/src/
 * html_preview.rs) and the frame loads it by URL. That response carries its
 * own closed policy; a srcdoc frame would inherit the app's, which allows no
 * inline script, so a generated page never ran in the installed app.
 *
 * In the browser build there is no scheme. The page goes in as srcdoc with the
 * closed policy as its first tag (the same one the phone preview uses); the
 * network switch cannot open anything there, which errs on the safe side.
 *
 * Nothing here runs on its own: the caller asks on the user's click.
 */
import { isTauri, backendCall } from '../api/backend'
import { withPolicyOnly } from '../mobile/screens/agent/parts/preview-doc'

/** The scheme the Rust side registers. */
export const PREVIEW_SCHEME = 'luprev'

export type PreviewSource =
  | { kind: 'src'; src: string }
  | { kind: 'doc'; doc: string }

/** The URL of a stored page: `luprev://localhost/<id>` on macOS and Linux,
 *  `http://luprev.localhost/<id>` on Windows and Android (Tauri's own rule). */
export async function previewUrl(id: string): Promise<string> {
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return convertFileSrc(id, PREVIEW_SCHEME)
}

/** Put the document up for one preview and say how the frame loads it. */
export async function putPreviewDocument(doc: string, allowNetwork: boolean): Promise<PreviewSource> {
  if (!isTauri()) return { kind: 'doc', doc: withPolicyOnly(doc) }
  const id = await backendCall<string>('html_preview_put', { doc, allowNetwork })
  return { kind: 'src', src: await previewUrl(id) }
}
