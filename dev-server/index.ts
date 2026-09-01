import type { Plugin } from 'vite'
import type { RouteMount } from './routes'
import { createLocalApiGuard } from './guard'
import { autostartOllama } from './ollama'
import {
  autostartComfy,
  createComfyLauncher,
  registerComfyControlRoutes,
  registerComfyInstallRoutes,
} from './comfy'
import { registerProxyRoutes } from './proxy-routes'
import { registerRemoteStubs } from './remote-stubs'
import { registerDownloadRoutes } from './downloads'
import { registerExecRoutes } from './exec-routes'
import { registerFsRoutes } from './fs-routes'
import { registerSystemRoutes } from './system-routes'
import { registerWebSearchRoutes } from './web-search'
import { registerWhisperRoutes } from './whisper'

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
}

/**
 * Der Dev-Server von `npm run dev` als Vite-Plugin.
 *
 * Diese Datei ist nur noch die Reihenfolge: connect verteilt in der
 * Reihenfolge der Registrierung, und sie ist hier dieselbe wie in den 2 120
 * Zeilen, die vorher in vite.config.ts standen — Wächter zuerst, dann die
 * Proxies, dann die Endpunkte.
 */
export function devServerPlugin({ port }: DevServerOptions): Plugin {
  const comfy = createComfyLauncher()

  return {
    name: 'lu-dev-server',
    configureServer(server) {
      const routes: RouteMount = {
        use: (path, handler) => { server.middlewares.use(path, handler) },
      }

      routes.use('/local-api', createLocalApiGuard(port))

      autostartOllama()
      autostartComfy(comfy)

      // Auto-stop ComfyUI when dev server closes
      server.httpServer?.on('close', comfy.stopComfy)
      process.on('exit', comfy.stopComfy)
      process.on('SIGINT', () => { comfy.stopComfy(); process.exit() })
      process.on('SIGTERM', () => { comfy.stopComfy(); process.exit() })

      registerProxyRoutes(routes)
      registerRemoteStubs(routes)
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
