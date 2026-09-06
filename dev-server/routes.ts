import type { Connect } from 'vite'

/**
 * Wohin ein Dev-Server-Endpunkt gehängt wird.
 *
 * Die Register-Funktionen dieses Ordners bekamen früher den ganzen
 * `ViteDevServer` und riefen `server.middlewares.use(…)` darauf. Damit war
 * jeder Handler nur erreichbar, wenn man einen echten Vite-Dev-Server hochfuhr
 * — also mit ComfyUI-Starter, Ollama-Spawn und Whisper-Prozess daran. Das ist
 * der Grund, warum an diesen 2000 Zeilen nie ein Test hing.
 *
 * Diese Schnittstelle ist die ganze Abhängigkeit: ein `use`. In der App reicht
 * sie `server.middlewares.use` durch (dev-server/index.ts), im Test sammelt
 * sie die Handler ein, die daraufhin auf einem ECHTEN node:http-Server laufen
 * und ECHTE Anfragen beantworten. Es wird also kein Server nachgebaut — es ist
 * derselbe Handler, den `npm run dev` ausliefert.
 */
export interface RouteMount {
  use(path: string, handler: Connect.NextHandleFunction): void
}
