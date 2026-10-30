/**
 * Where a chat HTML preview gets its page from (B29, 3.0.9).
 *
 * In the app the page is put up on a loopback server (src-tauri/src/
 * html_preview.rs, http://127.0.0.1:<random port>/<token>) and the frame
 * loads it by URL. That response carries its own closed policy; a srcdoc
 * frame would inherit the app's, which allows no inline script, so a
 * generated page never ran in the installed app. Loopback and not a custom
 * scheme because Tauri counts its registered schemes as the app's own origin;
 * a frame on 127.0.0.1 is a remote origin to Tauri. The server runs while a
 * preview is open: every page put up here is closed again by its caller.
 *
 * In the browser build there is no scheme. The page goes in as srcdoc with a
 * closed policy as its first tag (same rule as the phone preview's
 * withPolicyOnly, which the desktop may not import); the network switch
 * cannot open anything there, which errs on the safe side.
 *
 * Nothing here runs on its own: the caller asks on the user's click.
 */
import { isTauri, backendCall } from '../api/backend'

export type PreviewSource =
  | { kind: 'src'; src: string; id: string }
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

/** Put the document up for one preview and say how the frame loads it. */
export async function putPreviewDocument(doc: string, allowNetwork: boolean): Promise<PreviewSource> {
  if (!isTauri()) return { kind: 'doc', doc: withClosedPolicy(doc) }
  const page = await backendCall<{ id: string; url: string }>('html_preview_put', { doc, allowNetwork })
  return { kind: 'src', src: page.url, id: page.id }
}

/** The preview went. The last one closed stops the loopback server. */
export function closePreviewDocument(source: PreviewSource): void {
  if (source.kind !== 'src') return
  void backendCall('html_preview_close', { id: source.id }).catch(() => {})
}
