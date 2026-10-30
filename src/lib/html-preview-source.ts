/**
 * Where a chat HTML preview gets its page from (B29, 3.0.9).
 *
 * In the app the page is put up on the `luprev` scheme (src-tauri/src/
 * html_preview.rs) and the frame loads it by URL. That response carries its
 * own closed policy; a srcdoc frame would inherit the app's, which allows no
 * inline script, so a generated page never ran in the installed app.
 *
 * In the browser build there is no scheme. The page goes in as srcdoc with a
 * closed policy as its first tag (same rule as the phone preview's
 * withPolicyOnly, which the desktop may not import); the network switch
 * cannot open anything there, which errs on the safe side.
 *
 * Nothing here runs on its own: the caller asks on the user's click.
 */
import { isTauri, backendCall } from '../api/backend'

/** The scheme the Rust side registers. */
export const PREVIEW_SCHEME = 'luprev'

export type PreviewSource =
  | { kind: 'src'; src: string }
  | { kind: 'doc'; doc: string }

/** The closed policy of the browser fallback: inline script and style, pictures it carries, nothing else. */
export const FALLBACK_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'"

/** A doctype, the html tag and the head tag, anchored at the start: the policy goes behind those and before anything the page could run. */
const POLICY_SPOT = /^\s*(?:<!doctype[^>]*>\s*)?(?:<html(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>\s*)?(?:<head(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>)?/i

export function withClosedPolicy(doc: string): string {
  const at = POLICY_SPOT.exec(doc)?.[0].length ?? 0
  return doc.slice(0, at) + `<meta http-equiv="Content-Security-Policy" content="${FALLBACK_CSP}">` + doc.slice(at)
}

/** The URL of a stored page: `luprev://localhost/<id>` on macOS and Linux,
 *  `http://luprev.localhost/<id>` on Windows and Android (Tauri's own rule). */
export async function previewUrl(id: string): Promise<string> {
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return convertFileSrc(id, PREVIEW_SCHEME)
}

/** Put the document up for one preview and say how the frame loads it. */
export async function putPreviewDocument(doc: string, allowNetwork: boolean): Promise<PreviewSource> {
  if (!isTauri()) return { kind: 'doc', doc: withClosedPolicy(doc) }
  const id = await backendCall<string>('html_preview_put', { doc, allowNetwork })
  return { kind: 'src', src: await previewUrl(id) }
}
