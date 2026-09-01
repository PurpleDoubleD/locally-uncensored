/**
 * Warten, bis eine Datei WIRKLICH auf der Platte liegt.
 *
 * Warum es dieses Modul gibt: zwei Schritte des Assistenten starten nach dem
 * Herunterladen einen Server auf der Datei — der Modellschritt `llama-server`
 * auf der Chat-GGUF, der Einbettungsschritt den Embeddings-Server auf der
 * nomic-GGUF. Beide duerfen das erst tun, wenn der Bytestrom zu Ende ist,
 * sonst startet die Maschine auf einem halben File. Das ist der EINZIGE
 * Zustand, den sich diese beiden Schritte teilen; alles andere an ihnen ist
 * privat. Genau deshalb steht er hier und nicht in einem von beiden.
 *
 * Gepollt statt abonniert, und das ist Absicht: der Fortschrittsbalken
 * darueber liest denselben Store im selben Takt. Ein zweiter Weg (Subscription
 * hier, Poll dort) waere ein zweiter Zeitbegriff fuer dieselbe Datei.
 */
import { useDownloadStore } from '../../stores/downloadStore'

/**
 * Loest auf, sobald der Download-Store die Datei als fertig meldet — oder
 * wirft, sobald er sie als fehlgeschlagen meldet.
 */
export const awaitDownloadComplete = (filename: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      const d = useDownloadStore.getState().downloads[filename]
      if (d?.status === 'complete') { clearInterval(poll); resolve() }
      else if (d?.status === 'error') { clearInterval(poll); reject(new Error(d.error || 'Download failed')) }
    }, 500)
  })
