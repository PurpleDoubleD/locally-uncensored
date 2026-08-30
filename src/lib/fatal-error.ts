/**
 * Boot-failure recovery helpers (Bug D — surfingbird1010 "app runs, no window").
 *
 * A throw while a persisted store hydrates from corrupt data fires at
 * module-import time — before the React ErrorBoundary can mount. With the window
 * starting hidden (visible:false), that left the app launched-but-invisible.
 * `mountFatalError` renders a minimal, plain-DOM recovery screen that cannot
 * itself throw and force-shows the hidden Tauri window. The Rust force-show
 * timeout is the ultimate net; this is the fast, actionable path.
 */

/**
 * zustand-persist keys holding SETTINGS / transient state — safe to reset.
 * Deliberately EXCLUDES user DATA so a reset never destroys content:
 *   chat-conversations (chats) · rag-store (knowledge) ·
 *   locally-uncensored-memory (curated memory/brain).
 */
export const SETTINGS_STORAGE_KEYS = [
  'chat-settings',
  'lu-providers',
  'locally-uncensored-voice',
  'chat-models',
  'create-store',
  'locally-uncensored-codex',
  'locally-uncensored-mcp-servers',
  'locally-uncensored-permissions',
  'locally-uncensored-agent',
  'locally-uncensored-agent-mode',
  'locally-uncensored-agent-workflows',
  'locally-uncensored-model-health',
  'workflow-store',
  'lu-update-checker-v2',
  'lu-benchmark-store',
  'lu_cloud_notice',
  'lu_comfy_notice',
]

/** Force the (initially hidden) Tauri window visible so recovery UI is seen. */
export function forceShowWindow(): void {
  try {
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
    if (typeof window !== 'undefined' && w.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('show_window').catch(() => {}))
        .catch(() => {})
    }
  } catch { /* ignore — best effort */ }
}

/** Clear settings/state keys (keeps chats/knowledge/memory) and reload. */
export function resetSettingsAndReload(): void {
  try {
    for (const k of SETTINGS_STORAGE_KEYS) {
      try { localStorage.removeItem(k) } catch { /* ignore one bad key */ }
    }
  } finally {
    window.location.reload()
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

/** Plain-DOM fatal-error screen for a boot throw the ErrorBoundary can't catch. */
export function mountFatalError(rootEl: HTMLElement, err: unknown): void {
  forceShowWindow()
  // eslint-disable-next-line no-console
  try { console.error('[LU] fatal boot error', err) } catch { /* ignore */ }
  const message = err instanceof Error ? err.stack || err.message : String(err)
  const btn =
    'cursor:pointer;border-radius:8px;padding:8px 16px;font-size:13px;' +
    'border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#e5e5e5'
  rootEl.innerHTML =
    '<div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:14px;background:#171717;color:#e5e5e5;' +
    'font-family:system-ui,-apple-system,sans-serif;padding:24px;text-align:center">' +
    '<div style="font-size:18px;font-weight:600">LU couldn’t start</div>' +
    '<div style="font-size:12px;color:#9ca3af;max-width:560px;max-height:160px;overflow:auto;' +
    'white-space:pre-wrap;word-break:break-word;text-align:left;background:rgba(0,0,0,0.3);' +
    'padding:10px;border-radius:8px">' + escapeHtml(message) + '</div>' +
    '<div style="display:flex;gap:12px;margin-top:6px">' +
    '<button id="lu-fatal-reload" style="' + btn + '">Reload</button>' +
    '<button id="lu-fatal-reset" style="' + btn + '">Reset settings &amp; reload</button>' +
    '</div>' +
    '<div style="font-size:11px;color:#6b7280;max-width:520px">Reset clears app settings ' +
    '(providers, preferences) but keeps your chats &amp; knowledge.</div>' +
    '</div>'
  document.getElementById('lu-fatal-reload')?.addEventListener('click', () => window.location.reload())
  document.getElementById('lu-fatal-reset')?.addEventListener('click', resetSettingsAndReload)
}
