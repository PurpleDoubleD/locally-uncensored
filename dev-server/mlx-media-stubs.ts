import type { Connect } from 'vite'
import type { RouteMount } from './routes'

/**
 * K7 (GH #135, `npm run dev` without Tauri): "Unknown backend
 * command: install_mlx_diffusion". The MLX image/video pipeline
 * (`src-tauri/src/commands/media_cmds.rs`) is an in-process Mac-only Rust
 * module, a Python sidecar Rust spawns directly, with no dev-server
 * equivalent, and unlike Remote Access (see remote-stubs.ts) it had NEITHER
 * a pre-guard in the frontend NOR a backstop stub here. Every call the
 * MLX/video Settings panel makes on mount (`mlxStatus`, `getVideoStatus`,
 * `listMlxImageModels`, `listVideoModels`) is unconditionally reached the
 * moment that panel renders on a Mac running the plain Vite dev server,
 * confirmed by grepping every `invokeMedia('...')` call site in
 * src/api/mlx-image.ts and src/api/mlx-video.ts against endpointMap in
 * backend.ts, the same systematic check K7 asked for.
 *
 * Same shape as remote-stubs.ts: one honest HTTP 501 + JSON body per
 * command, so `backendCall` throws a clear actionable Error instead of
 * "Unknown backend command: X". The frontend already tolerates this:
 * status/list calls are wrapped in `.catch(() => null | [])` in
 * MlxMediaSettings' `refresh()`, and the install/generate/delete actions
 * run inside a try/catch that surfaces `e.message` directly as the on-screen
 * error, which is exactly why a plain string message (not a bespoke shape
 * per command) is enough here, same reasoning as install_tts in whisper.ts.
 *
 * `install_mlx_diffusion` / `install_mlx_diffusion_status` and
 * `video_install_mlx` / `video_install_mlx_status` share one path each,
 * mirroring install_tts's own kickoff+status pair.
 */
export function registerMlxMediaStubs(routes: RouteMount): void {
  const MLX_DEV_MODE_BODY = JSON.stringify({
    error: 'The local MLX image/video engine is only available in the desktop app (Apple Silicon). Run the packaged Locally Uncensored to use it.',
    devModeOnly: true,
    // Shape overlap with MlxInstallStatus/InstallStatus (status/logs/error)
    // so a caller that reads those fields on a 501 body still sees an
    // honest "not running" answer instead of undefined.
    status: 'error',
    logs: [] as string[],
    installed: false,
    running: false,
  })
  const mlxStubPaths = [
    '/local-api/mlx-status',
    '/local-api/mlx-start',
    '/local-api/mlx-unload',
    '/local-api/mlx-generate',
    '/local-api/mlx-enhance-prompt',
    '/local-api/mlx-loras',
    '/local-api/mlx-loras-open-folder',
    '/local-api/mlx-lora-delete',
    '/local-api/mlx-output-trash',
    '/local-api/mlx-cutout',
    '/local-api/mlx-upscale',
    '/local-api/mlx-image-models',
    '/local-api/mlx-image-install-model',
    '/local-api/mlx-image-install-status',
    '/local-api/mlx-image-cancel-install',
    '/local-api/mlx-image-delete-model',
    '/local-api/install-mlx-diffusion',
    '/local-api/set-hf-token',
    '/local-api/hf-token-present',
    '/local-api/video-status',
    '/local-api/video-list-models',
    '/local-api/video-install-mlx',
    '/local-api/video-install-model',
    '/local-api/video-install-model-status',
    '/local-api/video-cancel-model-install',
    '/local-api/video-delete-model',
    '/local-api/video-stage-start-image',
    '/local-api/video-stage-motion-video',
    '/local-api/video-generate',
    '/local-api/video-progress',
    '/local-api/video-cancel',
    '/local-api/video-color-settle',
    '/local-api/read-media-file',
    '/local-api/mlx-music-status',
    '/local-api/mlx-music-install',
    '/local-api/mlx-music-install-status',
    '/local-api/mlx-music-cancel-install',
    '/local-api/mlx-music-delete',
    '/local-api/mlx-music-generate',
    '/local-api/mlx-music-progress',
    '/local-api/mlx-music-cancel',
    '/local-api/mlx-train-status',
    '/local-api/mlx-train-stage',
    '/local-api/mlx-train-clear',
    '/local-api/mlx-train-start',
    '/local-api/mlx-train-progress',
    '/local-api/mlx-train-cancel',
  ]
  const mlxDevModeStub: Connect.SimpleHandleFunction = (_req, res) => {
    res.writeHead(501, { 'Content-Type': 'application/json' })
    res.end(MLX_DEV_MODE_BODY)
  }
  for (const path of mlxStubPaths) {
    routes.use(path, mlxDevModeStub)
  }
}
