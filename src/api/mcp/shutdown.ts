/**
 * T-53, second half — nothing disconnected the external MCP servers when the
 * app went away, so their child processes were left behind.
 *
 * ── What already cleans up, and what does not ────────────────────────────
 *
 * `AppState::shutdown_subprocesses()` (`src-tauri/src/state.rs:462`) kills the
 * children RUST spawned and tracks in AppState: Ollama, ComfyUI, the bundled
 * llama-server and embeddings server, the MLX video subprocess and image
 * sidecar, the LoRA trainer, the installer child trees, whisper. External MCP
 * servers are none of those — they are spawned from the frontend through
 * `@tauri-apps/plugin-shell`, land in the PLUGIN's child map, and never appear
 * in AppState. So this file does not duplicate that function; the two have an
 * empty intersection.
 *
 * The overlap that does exist is with the shell plugin itself:
 * `tauri-plugin-shell` 2.3.5 sweeps its own child map on `RunEvent::Exit`
 * (`src/lib.rs:132-143`) and kills every child. That covers the packaged app's
 * real quit paths — tray Quit, `exit_app`, Cmd+Q — and it is not double work,
 * because the JS `kill()` we issue below goes through the plugin's own
 * `kill` command, which REMOVES the pid from that same map before killing it
 * (`src/commands.rs:300-309`). Whoever gets there first takes the entry; the
 * other finds nothing. One registry, one kill.
 *
 * ── Why the trigger is page unload and NOT onCloseRequested ──────────────
 *
 * The obvious Tauri hook is the wrong one here. In this app the window's X
 * does not quit: `main.rs:549` calls `api.prevent_close()` and hides to the
 * tray, deliberately, and the window comes back with Show. Hanging the MCP
 * teardown off `onCloseRequested` would kill every connected server every time
 * the user pressed X and expected the app to keep standing.
 *
 * What no layer covers is the WEBVIEW going away without the process going
 * away: a `tauri dev` HMR full reload, a `location.reload()`, the recovery
 * path in `main.tsx`. The plugin's Exit sweep does not fire, and the JS side
 * loses the only handle to those processes (the client map is module state),
 * so they stay resident with nobody able to reach them for the rest of the
 * app's life. That is the orphan this file exists for.
 *
 * And it is ONE path, not one per mode. `pagehide` and `beforeunload` are two
 * TRIGGERS for the same single implementation
 * (`disconnectAllExternalServers`), registered identically whether the app is
 * running packaged or under `npm run dev`; both fire in a browser and in the
 * WKWebView/WebView2 the packaged app uses. Under plain `npm run dev` there is
 * no Tauri IPC, so no MCP server can have been spawned at all and the sweep
 * finds an empty set — the same code doing nothing, rather than a second code
 * path that only one mode has.
 *
 * ── What this cannot promise ─────────────────────────────────────────────
 *
 * `child.kill()` is an async IPC call. An unload handler cannot await, so the
 * request is posted and the page goes away; the Rust side normally receives it
 * because the post is synchronous, but nothing here can prove the process was
 * reaped. And the plugin's kill is a kill of the DIRECT child only — for
 * `npx -y some-mcp-server` (or `npx.cmd` on Windows) that is the launcher, and
 * the node process it forked is not in any tree walk. Closing that needs a
 * `kill_tree` on the Rust side, which is out of scope here.
 */
import { disconnectAllExternalServers } from './external-client'

/**
 * Set while a sweep is in flight, so the two triggers cannot double-fire.
 * Cleared when the sweep settles rather than latched for good: on a real
 * unload nothing gets that far, but a page that survives (a cancelled
 * navigation, a bfcache restore) must still be sweepable the next time.
 */
let sweeping = false
/** The listeners this module installed, so `installMcpShutdown` stays idempotent. */
let installed: (() => void) | null = null

/**
 * Run the teardown once. Exported for the test, which is the only place that
 * can drive it deterministically — an unload handler cannot be awaited.
 */
export function sweepMcpServers(): Promise<number> {
  if (sweeping) return Promise.resolve(0)
  sweeping = true
  return disconnectAllExternalServers().finally(() => { sweeping = false })
}

/**
 * Wire the teardown to the page going away. Idempotent: calling it twice
 * (React StrictMode, a re-entrant boot) installs one set of listeners.
 * Returns an uninstaller, which the app does not use — the hook is meant to
 * live for the whole session.
 */
export function installMcpShutdown(): () => void {
  if (installed) return installed
  if (typeof window === 'undefined') return () => {}

  const onGone = () => { void sweepMcpServers() }
  // Two triggers, one implementation. `pagehide` is the one that actually
  // fires on a reload in WebKit/WebView2; `beforeunload` is kept because it is
  // the earlier of the two and costs nothing when both arrive — `sweeping`
  // makes the second call a no-op.
  window.addEventListener('pagehide', onGone)
  window.addEventListener('beforeunload', onGone)

  installed = () => {
    window.removeEventListener('pagehide', onGone)
    window.removeEventListener('beforeunload', onGone)
    installed = null
  }
  return installed
}

/** Test-only: the latch and the listeners are process-lifetime state by design. */
export function __resetMcpShutdownForTests(): void {
  installed?.()
  sweeping = false
}
