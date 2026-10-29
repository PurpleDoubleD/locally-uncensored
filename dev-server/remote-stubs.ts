import type { Connect } from 'vite'
import type { RouteMount } from './routes'

/** Die vierunddreissig Remote-Access-Endpunkte, die es im reinen Vite-Prozess nicht gibt. */
export function registerRemoteStubs(routes: RouteMount): void {
  // ─── Remote Access stubs (dev mode) ───────────────────────────
  // Reported by a user on v2.4.2: clicking LAN/Internet from
  // `npm run dev` returned an HTML 404 page that the frontend then
  // tried to JSON.parse, producing a cryptic
  // "SyntaxError: unexpected character at line 1 column 1" stacktrace.
  //
  // Remote Access is fundamentally a Tauri-only feature: a Rust axum
  // server, JWT auth, Cloudflare tunnel binary management,
  // mobile-UI static serve. None of that exists in the vite dev
  // process. Mirroring it here would mean reimplementing ~3700 lines
  // of Rust in Node middleware plus a forever maintenance burden.
  //
  // Instead: respond with HTTP 501 + a structured JSON body so the
  // frontend can surface a clear actionable error. The Sidebar +
  // remoteStore already short-circuit before fetch() in dev mode
  // (REMOTE_DEV_MODE_ERROR); these stubs are the backstop for any
  // future caller that bypasses those guards.
  const REMOTE_DEV_MODE_BODY = JSON.stringify({
    error: "Remote Access requires the installed desktop app. Use `npm run tauri:dev` for full Remote in development — the plain vite dev server can't host the Rust backend Remote needs.",
    devModeOnly: true,
  })
  const remoteStubPaths = [
    '/local-api/start-remote-server',
    '/local-api/stop-remote-server',
    '/local-api/restart-remote-server',
    '/local-api/remote-server-status',
    '/local-api/regenerate-remote-token',
    '/local-api/remote-qr-code',
    '/local-api/remote-connected-devices',
    '/local-api/disconnect-remote-device',
    '/local-api/set-remote-permissions',
    '/local-api/set-remote-page-title',
    '/local-api/start-tunnel',
    '/local-api/stop-tunnel',
    '/local-api/tunnel-status',
    '/local-api/remote-pairing-qr',
    '/local-api/remote-pairing-window',
    '/local-api/remote-paired-devices',
    '/local-api/remote-forget-device',
    '/local-api/remote-set-device-rights',
    '/local-api/remote-set-new-device-rights',
    '/local-api/remote-firewall-status',
    '/local-api/remote-firewall-allow',
    '/local-api/remote-pair-decide',
    '/local-api/remote-pair-requests',
    '/local-api/remote-set-anywhere',
    '/local-api/remote-set-legacy-access',
    '/local-api/remote-signin-requests',
    '/local-api/remote-signin-decide',
    '/local-api/remote-create-progress',
    '/local-api/remote-create-finish',
    '/local-api/remote-create-capabilities-reply',
    '/local-api/remote-create-gallery-reply',
    '/local-api/remote-e2e-mode',
    '/local-api/remote-chats-sync',
    '/local-api/remote-chats-event',
    '/local-api/remote-chats-reply',
    '/local-api/remote-create-cancel',
    '/local-api/remote-create-snapshot',
  ]
  const remoteDevModeStub: Connect.SimpleHandleFunction = (_req, res) => {
    res.writeHead(501, { 'Content-Type': 'application/json' })
    res.end(REMOTE_DEV_MODE_BODY)
  }
  for (const path of remoteStubPaths) {
    routes.use(path, remoteDevModeStub)
  }

  // The Local API usage counter (local_api_usage) and the download speed
  // limit (set_download_limit) live in the Rust process as well. Both callers
  // already tolerate a failure: the panel shows no numbers, and the limit is
  // only sent from the desktop app.
  const DESKTOP_ONLY_BODY = JSON.stringify({
    error: 'This needs the installed desktop app. The plain vite dev server has no Rust backend.',
    devModeOnly: true,
  })
  // The training photos of a local character (character_photos) too: the
  // caller asks only inside the desktop app. The GGUF file dialog of the
  // Model Manager (pick_gguf_file) is a native dialog of the Rust process.
  // The node pack manager (list_custom_nodes, remove_custom_node,
  // custom_node_log) too: listing, the trash and the install log are Rust.
  // Check files and Repair of the Model Manager (GH #113): the digest job
  // and the Trash are Rust. So is the idle unload of the LU Engine
  // (set_engine_idle_unload), which the app sends only from the desktop app.
  // The card per task (3.0.8, A2) too: only the Rust process starts ComfyUI
  // and the chat engine that read it.
  // Remove refusals (A14) as well: its runs are Python processes the Rust
  // side starts, reads and stops.
  for (const path of [
    '/local-api/local-api-usage', '/local-api/set-download-limit', '/local-api/character-photos', '/local-api/pick-gguf-file',
    '/local-api/list-custom-nodes', '/local-api/remove-custom-node', '/local-api/custom-node-log',
    '/local-api/verify-model-files', '/local-api/verify-model-files-status', '/local-api/verify-model-files-cancel',
    '/local-api/trash-model-file', '/local-api/set-engine-idle-unload',
    '/local-api/set-gpu-roles', '/local-api/describe-gpu-roles',
    '/local-api/abliterate-plan', '/local-api/abliterate-start', '/local-api/abliterate-status',
    '/local-api/abliterate-cancel', '/local-api/abliterate-dismiss', '/local-api/abliterate-runs',
    '/local-api/abliterate-trash-copy',
    '/local-api/neuron-presets', '/local-api/neuron-info', '/local-api/neuron-build', '/local-api/neuron-feature-add', '/local-api/neuron-delete', '/local-api/neuron-sae-download', '/local-api/neuron-sae-search', '/local-api/neuron-status', '/local-api/neuron-cancel', '/local-api/neuron-dismiss', '/local-api/neuron-apply', '/local-api/neuron-compare',
  ]) {
    routes.use(path, (_req, res) => {
      res.writeHead(501, { 'Content-Type': 'application/json' })
      res.end(DESKTOP_ONLY_BODY)
    })
  }
}
