import type { Plugin } from 'vite'
import type { RouteMount } from './routes'
import { createLocalApiGuard } from './guard'
import { comfyBridgeGuard, createComfyBridgeAccess, type ComfyBridgeAccess } from './comfy-origin'
import { autostartOllama } from './ollama'
import {
  autostartComfy,
  createComfyLauncher,
  registerComfyControlRoutes,
  registerComfyInstallRoutes,
} from './comfy'
import { registerProxyRoutes } from './proxy-routes'
import { registerRemoteStubs } from './remote-stubs'
import { registerMlxMediaStubs } from './mlx-media-stubs'
import { registerVoiceLoopStubs } from './voice-loop-stubs'
import { registerComputerStubs } from './computer-stubs'
import { registerDownloadRoutes } from './downloads'
import { registerExecRoutes } from './exec-routes'
import { registerFsRoutes } from './fs-routes'
import { registerSystemRoutes } from './system-routes'
import { registerWebSearchRoutes } from './web-search'
import { registerWhisperRoutes } from './whisper'

/** Shape of the pieces of a ViteDevServer this needs, kept structural so
 *  tests can build a plain object instead of a real Vite instance. */
export interface LanOriginServer {
  config: { server: { host?: string | boolean } }
  resolvedUrls: { network: string[] } | null
}

/**
 * K8 (GH #134): the dev server's own LAN origin(s), derived ONLY from what
 * Vite itself resolved it is bound to, never from anything a request claims.
 * Only when `--host` was actually passed does Vite set
 * `server.config.server.host`; a plain `npm run dev` binds loopback only and
 * this returns []. `resolvedUrls` populates after listen(), so callers must
 * read this lazily (per request, inside the guard), never compute it once
 * and cache it, see the doc comment on getLanOrigins in guard.ts.
 *
 * A named export, not an inline closure, so dev-server/__tests__/
 * lan-origin-k8.test.ts exercises this exact function instead of a copy
 * retyped into the test file.
 */
export function lanOrigins(server: LanOriginServer): string[] {
  if (!server.config.server.host) return []
  return (server.resolvedUrls?.network ?? [])
    .map((u) => { try { return new URL(u).origin } catch { return null } })
    .filter((o): o is string => !!o)
}

/**
 * K8 nachbessert, Punkt 6: the one-line warning printed once the server is
 * actually bound with `--host`, so whoever started it sees that
 * /shell-execute and /execute-code (both behind /local-api) are now
 * reachable from anyone on the LAN, not only this machine. A pure function
 * (returns the message, or null when `--host` is not active) so
 * dev-server/__tests__ can assert on it without standing up a real Vite
 * HTTP server.
 */
export function hostWarningMessage(server: LanOriginServer): string | null {
  if (!server.config.server.host) return null
  return '[lu-dev-server] --host is active: /shell-execute and /execute-code ' +
    'are reachable from anyone on this LAN, not just this machine.'
}

export interface DevServerOptions {
  /**
   * Der Port, auf dem Vite bindet. Ein Parameter, damit der Server ein zweites
   * Mal gestartet werden kann, ohne eine Datei zu ändern (`LU_DEV_PORT`).
   *
   * NICHT die Origin-Regel des Wächters (KF-13): die ist „zwei Tauri-Origins,
   * sonst Loopback auf jedem Port" und kennt keinen kanonischen Port. Hier
   * stand einmal, er sei „der einzige Port, den die Origin-Prüfung als
   * kanonisch behandelt" — das war schon damals nicht wahr. guard.ts benutzt
   * die Zahl nur noch im Text der Ablehnung; siehe dort.
   */
  port: number
  comfyAccess?: ComfyBridgeAccess
  /** Explicit administrator-owned SSH/reverse-proxy browser origin. */
  publicOrigin?: string
}

/**
 * Der Dev-Server von `npm run dev` als Vite-Plugin.
 *
 * Diese Datei ist nur noch die Reihenfolge: connect verteilt in der
 * Reihenfolge der Registrierung, und sie ist hier dieselbe wie in den 2 120
 * Zeilen, die vorher in vite.config.ts standen — Wächter zuerst, dann die
 * Proxies, dann die Endpunkte.
 */
export function devServerPlugin({ port, publicOrigin, comfyAccess = createComfyBridgeAccess(publicOrigin) }: DevServerOptions): Plugin {
  const comfy = createComfyLauncher()

  return {
    name: 'lu-dev-server',
    configureServer(server) {
      comfyAccess.bind(server)
      const routes: RouteMount = {
        use: (path, handler) => { server.middlewares.use(path, handler) },
      }

      // K8 (GH #134): read lazily, per request, since resolvedUrls only
      // populates after listen(). See lanOrigins' own doc comment above.
      routes.use('/local-api', createLocalApiGuard(port, () => lanOrigins(server), publicOrigin))

      // This namespace carries multipart uploads, media and WebSockets, so it
      // needs an origin boundary without /local-api's JSON-only requirement.
      routes.use('/comfyui', comfyBridgeGuard(comfyAccess))

      // K8 nachbessert, Punkt 6: warn once, after Vite has actually bound to
      // the network interface, that --host also exposes /shell-execute and
      // /execute-code (both under /local-api) to anyone on the LAN, not just
      // this machine. Read lazily off the real listener the same way the
      // guard above does, so this fires only when --host truly took effect.
      server.httpServer?.once('listening', () => {
        const warning = hostWarningMessage(server)
        if (warning) console.warn(warning)
      })

      autostartOllama()
      autostartComfy(comfy)

      // Auto-stop ComfyUI when dev server closes
      server.httpServer?.on('close', comfy.stopComfy)
      process.on('exit', comfy.stopComfy)
      process.on('SIGINT', () => { comfy.stopComfy(); process.exit() })
      process.on('SIGTERM', () => { comfy.stopComfy(); process.exit() })

      registerProxyRoutes(routes)
      registerRemoteStubs(routes)
      registerMlxMediaStubs(routes)
      registerVoiceLoopStubs(routes)
      registerComputerStubs(routes)
      registerComfyControlRoutes(routes, comfy)
      registerDownloadRoutes(routes)
      registerComfyInstallRoutes(routes, comfy)
      registerExecRoutes(routes)
      registerFsRoutes(routes)
      registerSystemRoutes(routes)
      registerWebSearchRoutes(routes)
      registerWhisperRoutes(routes, (cb) => {
        server.httpServer?.on('close', cb)
        process.on('exit', cb)
      })
    },
  }
}
