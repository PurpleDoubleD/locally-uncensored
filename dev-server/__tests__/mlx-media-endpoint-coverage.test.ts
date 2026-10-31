/**
 * K7 (GH #135): "Unknown backend command: install_mlx_diffusion"
 * in `npm run dev` without Tauri. Root cause: the MLX image/video Rust
 * module (`commands::media_cmds`) had no dev-server route, and unlike
 * Remote Access (remote-stubs.ts) no frontend pre-guard either, so every
 * `invokeMedia('...')` call in src/api/mlx-image.ts / mlx-video.ts is
 * unconditionally reached the moment MlxMediaSettings renders on a Mac.
 *
 * This is the systematic check the fix is built on, kept as a live test so
 * it holds going forward: it reads src-tauri/src/lib.rs for every
 * registered Tauri command, greps src/ for every literal command name
 * actually passed to `backendCall(...)` / `invokeMedia(...)` (the same
 * two-pass method used to find this gap), and asserts every one of those
 * REACHABLE commands has an endpointMap entry in backend.ts. A future
 * commands::media_cmds (or any other module's) command that gets called
 * from the frontend but never wired into endpointMap fails this test
 * instead of shipping silently.
 *
 * Deliberately NOT a check of all ~190 registered commands: most of them
 * (window management, OAuth loopback, keychain, native file dialogs, ...)
 * are legitimately Tauri-only and are never reached via backendCall/
 * invokeMedia from the browser dev surface at all; asserting endpointMap
 * coverage for those would mean inventing dev-mode behavior for features
 * that were never broken in the first place. "Reachable" is measured, not
 * assumed: the whole point of this posten was not to guess.
 *
 * Run: npx vitest run dev-server/__tests__/mlx-media-endpoint-coverage.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')

/** Every command name registered in tauri::generate_handler![...]. */
function rustCommands(): Set<string> {
  const mainRs = readFileSync(join(REPO_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf-8')
  const m = mainRs.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\n\s*\]\)/)
  if (!m) throw new Error('Could not find tauri::generate_handler![...] block in lib.rs. Has the invoke_handler setup moved?')
  const names = new Set<string>()
  for (let line of m[1].split('\n')) {
    line = line.split('//')[0].trim().replace(/,$/, '')
    if (!line) continue
    const parts = line.split('::')
    names.add(parts[parts.length - 1])
  }
  return names
}

/** Every command name literal passed to `backendCall(...)` or `invokeMedia(...)`
 *  anywhere under src/ (excluding tests). Mirrors the systematic script used
 *  to find the K7 gap: a source-level reachability measurement, not a guess. */
function reachableCommands(): Set<string> {
  const pattern = /(?:backendCall|invokeMedia)(?:<[^>]*>)?\(\s*['"]([a-zA-Z0-9_]+)['"]/g
  const names = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) { walk(full); continue }
      if (!(entry.endsWith('.ts') || entry.endsWith('.tsx'))) continue
      const content = readFileSync(full, 'utf-8')
      for (const match of content.matchAll(pattern)) names.add(match[1])
    }
  }
  walk(join(REPO_ROOT, 'src'))
  return names
}

/** endpointMap keys, read out of backend.ts rather than imported: the dev
 *  branch of backendCall() only builds that object at call time, and this
 *  test wants the literal keys, not a live network round trip. */
function endpointMapKeys(): Set<string> {
  const backendTs = readFileSync(join(REPO_ROOT, 'src', 'api', 'backend.ts'), 'utf-8')
  const m = backendTs.match(/const endpointMap: Record<string, \{ path: string; method\?: string \}> = \{([\s\S]*?)\n\s*\};/)
  if (!m) throw new Error('Could not find endpointMap in backend.ts. Has it moved or been renamed?')
  const keys = new Set<string>()
  for (const match of m[1].matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*):\s*\{/gm)) keys.add(match[1])
  return keys
}

describe('endpointMap covers every backendCall/invokeMedia site the frontend can reach', () => {
  const rust = rustCommands()
  const reachable = reachableCommands()
  const mapped = endpointMapKeys()

  it('sanity: the three extractors actually found something', () => {
    expect(rust.size).toBeGreaterThan(100)
    expect(reachable.size).toBeGreaterThan(50)
    expect(mapped.size).toBeGreaterThan(20)
  })

  it('the MLX/video commands from K7 (GH #135) are mapped', () => {
    const mlxCommands = [
      'mlx_status', 'mlx_start', 'mlx_unload', 'mlx_generate', 'mlx_image_models',
      'mlx_image_install_model', 'mlx_image_install_status', 'mlx_image_cancel_install', 'mlx_image_delete_model',
      'install_mlx_diffusion', 'install_mlx_diffusion_status', 'set_hf_token', 'hf_token_present',
      'video_status', 'video_list_models', 'video_install_mlx', 'video_install_mlx_status',
      'video_install_model', 'video_install_model_status', 'video_cancel_model_install', 'video_delete_model',
      'video_generate', 'video_stage_start_image', 'video_stage_motion_video', 'video_progress', 'video_cancel', 'read_media_file',
      // Delete in the gallery of a Mac (commands/mlx_outputs.rs).
      'mlx_output_trash',
      // Remove Background on a Mac (commands/mlx_cutout.rs).
      'mlx_cutout',
      // Enhance Image on a Mac (commands/mlx.rs mlx_upscale).
      'mlx_upscale',
    ]
    for (const cmd of mlxCommands) {
      expect(rust.has(cmd), `${cmd} should still be a registered Tauri command`).toBe(true)
      expect(reachable.has(cmd), `${cmd} should still be called via backendCall/invokeMedia somewhere`).toBe(true)
      expect(mapped.has(cmd), `${cmd} is reachable but missing from endpointMap`).toBe(true)
    }
  })

  // K7 asked for a systematic check against ALL registered commands, which is
  // exactly what reachableCommands()/rustCommands() do. But "the frontend
  // has a literal call site" is not the same claim as "this is broken in dev
  // mode": most of these are legitimately Tauri-only (keychain, native file
  // dialogs, OAuth loopback, window management, background shell tasks) and
  // many call sites are already gated behind an `isTauri()` check upstream
  // that this text-level scan cannot see, so they were never reachable from
  // `npm run dev` the way install_mlx_diffusion was. Fixing K7 meant
  // confirming and closing the MLX/video gap (the module the bug report
  // named, and its siblings, see the test above), not inventing dev-mode
  // behavior for ~90 unrelated commands never reported broken.
  //
  // This list is the exact remaining measured gap as of this fix (K7,
  // 2026-09-18), kept explicit, not silently ignored, so a maintainer can
  // pick individual ones off it later (the owner/orchestrator to prioritize; a
  // few look like real drift worth a closer look on their own, e.g.
  // local_api_status/restart_remote_server/revoke_remote_memory landed in
  // lib.rs after remote-stubs.ts's list was last updated). The test still
  // fails the moment ANY command outside this list, including a brand new
  // one, is called from the frontend without an endpointMap entry.
  const PRE_EXISTING_UNMAPPED_GAPS = new Set([
    'backup_rag_chunks', 'backup_stores', 'bundled_embed_status', 'bundled_engine_status',
    'cancel_character_training', 'cancel_comfyui_install', 'character_trainer_status',
    'character_training_status', 'check_download_space', 'clear_download_entry',
    'clear_training_set', 'comfy_upload_image', 'delete_bundled_model', 'delete_orphan_download',
    'detect_gpus', 'disconnect_remote_device', 'download_voice',
    // execute_code_cancel (R2-44): the execute_code counterpart to
    // shell_execute_cancel below, same reasoning, same Tauri-only shape
    // (Rust kills the process tree by callId, no HTTP route makes sense).
    'execute_code_cancel',
    // Image part of a cancelled model download (October 2026): removes the
    // finished part next to a GGUF in the built-in engine's models folder.
    // Same Tauri-only shape as clear_download_entry and delete_bundled_model
    // above: the built-in engine does not exist under `npm run dev`.
    'remove_image_part',
    // Chat attachments (OOM fix, 2026-09-26): files beside store_backup.json
    // and native Save As / Open dialogs. Every call site sits behind isTauri()
    // (lib/chat-attachments.ts, ChatAttachment.tsx, chat-export.ts,
    // ChatBackupSettings.tsx); the browser build keeps its images in IndexedDB
    // and exports through a blob download, so there is no dev route to add.
    'export_chats_dialog', 'import_chats_dialog', 'read_chat_attachment',
    'save_binary_file_dialog', 'save_chat_attachment_dialog', 'write_chat_attachment',
    // Model header sniff (Discord 2026-09-28): reads safetensors headers in
    // the local ComfyUI model folders. The only call site (applyHeaderSniff in
    // api/comfyui.ts) sits behind isTauri() and keeps the name-based answer
    // everywhere else, so there is no dev route to add.
    'sniff_model_files',
    // Gallery delete to the Recycle Bin (lib/gallery-trash.ts), behind
    // isTauri(): the browser build has no filesystem to clean.
    'trash_comfy_output',
    // Starts the app again after the updater plugin has installed (GitHub
    // discussion 150, stores/updateStore.ts). Only reachable with an Update
    // handle from the plugin, which the dev server never hands out.
    'restart_after_update',
    // Where ComfyUI models land when ComfyUI runs on another machine (GH
    // #143, api/discover.ts comfyModelTarget). A missing route answers
    // "local", which is what the dev server always is.
    'comfy_model_target',
    // Delete one file of the agent folder of a chat (mobile round 2, the file
    // viewer of the phone, screens/chat/parts/workspace-files.ts). The only
    // call site is the phone shell. Without a route the browser answers
    // "Unknown backend command", which the viewer reads as "this build cannot
    // delete" and says so. A dev route would be a way to delete files on the
    // developer machine that nothing needs, so there is none on purpose.
    'fs_delete',
    // The native copy of the saved characters of Create beside the store
    // backup (mobile round 38, gap L3, mobile/lib/saved-characters-backup.ts).
    // Registered on a phone only (lib.rs, #[cfg(mobile)]); every call runs
    // after installSavedCharactersBackup(), which needs isTauri() and
    // isMobile(). The browser build keeps the characters in IndexedDB and has
    // no native side to copy them to, so there is no dev route to add.
    'saved_characters_backup_missing', 'saved_characters_backup_put',
    'saved_characters_backup_read_index', 'saved_characters_backup_read_photo',
    'saved_characters_backup_write_index',
    // Ends a running `lmstudio_load_model` (api/lmstudio.ts). The load itself
    // has no dev route (it is in the list below), so there is nothing a dev
    // route for its cancel could end.
    'lmstudio_cancel_load',
    // N1: the LM Studio runtime check before an LFM3 load (api/lmstudio.ts),
    // inside the same load that has no dev route.
    'lmstudio_gguf_runtime',
    // The folder of the voice engine and LU's own Python (Discord D2,
    // components/settings/RuntimeFolderSetting.tsx). The row only renders
    // behind isTauri(): the browser build has no voice engine and no Python
    // of its own to place, so there is no dev route to add.
    'move_runtime_folder', 'runtime_folder_status', 'set_runtime_folder',
    // What LU installs into a ComfyUI environment on this machine (3.0.8,
    // components/settings/HardwareSettings.tsx). Asked only behind isTauri():
    // the browser build never builds a ComfyUI environment.
    'comfy_torch_plan',
    // Settings, Storage folder (components/settings/StorageFolderSetting.tsx):
    // behind isTauri() for the same reason, the browser build has no files of
    // its own to place.
    'storage_apply', 'storage_cancel', 'storage_plan', 'storage_status',
    // The inbox of locallyuncensored://open-model links (P9, 3.0.9,
    // components/models/HfLinkInbox.tsx). Read only behind isTauri(): a link
    // from the system reaches the desktop app, never the browser build.
    'hf_link_take',
    // The chat's HTML preview page (B29, 3.0.9, lib/html-preview-source.ts).
    // Put up and closed only behind isTauri(): the browser build loads the
    // page as srcdoc and has no loopback server to serve it from.
    'html_preview_close', 'html_preview_put',
    'exit_app', 'file_read', 'find_orphan_downloads', 'fix_comfyui_cors', 'funnel_ping',
    'get_comfy_gpu_status', 'get_current_time', 'import_local_model', 'install_character_trainer',
    'install_lmstudio', 'install_lmstudio_status', 'install_method', 'install_python',
    'install_python_status', 'installed_piper_voices', 'is_onboarding_done', 'kv_slot_action',
    'list_agent_workspaces', 'list_bundled_models', 'list_importable_models', 'lmstudio_list_loaded',
    'lmstudio_load_model', 'lmstudio_model_context', 'lmstudio_model_dir', 'lmstudio_server_status',
    'lmstudio_unload_model', 'local_api_new_token', 'local_api_status', 'log_file_path', 'log_reveal',
    'offload_local_models', 'pick_folder', 'python_check', 'repair_comfyui_env', 'repo_map',
    'restart_remote_server', 'restore_rag_chunks', 'restore_stores', 'revoke_remote_memory',
    'save_text_file_dialog', 'self_migrate_finish', 'self_migrate_stage', 'set_chat_workspace_override',
    'set_comfy_gpu_mode', 'set_gpu_selection', 'set_onboarding_done', 'shell_execute_cancel',
    'shell_task_kill', 'shell_task_list', 'shell_task_start', 'shell_task_status', 'stage_training_image',
    'start_bundled_embed', 'start_bundled_engine', 'start_character_training', 'start_lmstudio_server',
    'start_local_api', 'start_ollama', 'stop_bundled_embed', 'stop_bundled_engine', 'stop_local_api',
    'swap_bundled_model', 'sync_custom_model_paths', 'synthesize', 'synthesize_external', 'system_health',
    'tts_status', 'update_comfyui', 'validate_workspace_folder', 'web_fetch',
  ])

  it('every command literally called from the frontend has an endpointMap entry (or a documented pre-existing exemption)', () => {
    const gaps = [...reachable].filter((cmd) => rust.has(cmd) && !mapped.has(cmd) && !PRE_EXISTING_UNMAPPED_GAPS.has(cmd)).sort()
    expect(gaps, `New reachable-but-unmapped command(s): ${gaps.join(', ')}. Add each to endpointMap in src/api/backend.ts with a matching dev-server route (see mlx-media-stubs.ts / remote-stubs.ts for the desktop-only-stub pattern).`).toEqual([])
  })

  it('the pre-existing exemption list has no stale entries (command removed, or since mapped)', () => {
    const stale = [...PRE_EXISTING_UNMAPPED_GAPS].filter((cmd) => !reachable.has(cmd) || !rust.has(cmd) || mapped.has(cmd)).sort()
    expect(stale, `These no longer need the exemption, remove from PRE_EXISTING_UNMAPPED_GAPS: ${stale.join(', ')}`).toEqual([])
  })
})
