/**
 * Welche Maschine der Assistent nachher anspricht — der geteilte Kern des
 * ganzen Assistenten.
 *
 * Warum es dieses Modul gibt: das Ergebnis des Port-Scans ist der einzige
 * Zustand, den FUENF der sechs Bildschirme anfassen, und zwei von ihnen
 * schreiben ihn:
 *
 *   Willkommen    startet den Scan beim Weiterklicken
 *   Backends      zeichnet ihn, laesst waehlen, scannt neu
 *   Modelle       entscheidet daran, WOHIN eine GGUF geschrieben wird
 *                 (Ollama-Pull, App-Ordner, LM-Studio-Verschachtelung)
 *   Einbettungen  entscheidet daran, welcher Embeddings-Weg genommen wird
 *   Fertig        nennt den verbundenen Backend beim Namen
 *
 * Genau deshalb steht er NICHT im Backend-Schritt, obwohl er dort gezeichnet
 * wird: ein Schritt, der den Zustand von vier anderen haelt, ist kein Schritt,
 * sondern die Schale mit einer Tarnkappe. Er steht hier, oberhalb der
 * Schritte, und wird ihnen gereicht.
 *
 * Was der Schritt dagegen SELBST behaelt: `detecting` faerbt nur seinen
 * eigenen Bildschirm — es steht trotzdem hier, weil `runDetection` es setzt
 * und die Funktion von zwei Bildschirmen gerufen wird. Ein Flag, das eine
 * Funktion setzt, gehoert zu der Funktion.
 */
import { useState } from 'react'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { BUILTIN_BACKEND_ID } from '../../lib/onboarding-backend'
import { backendCall } from '../../api/backend'
import { isTauri } from './onboarding-host'
import type { LmStudioServerStatus } from '../models/ModelSelector'

export interface BackendScan {
  detectedBackends: DetectedBackend[]
  detecting: boolean
  selectedBackend: string
  setSelectedBackend: (id: string) => void
  /** LM Studio liegt auf der Platte, sein Server hoert aber nicht zu. */
  lmstudioOfflineDetected: boolean
  /** GGUFs in `~/.lmstudio/models/`, als Vertrauenshinweis in der Karte. */
  lmstudioModelCount: number
  runDetection: () => Promise<void>
}

export function useBackendScan(): BackendScan {
  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [detecting, setDetecting] = useState(false)
  // 2.5.7: the built-in engine is the pre-selected default — a fresh install
  // needs nothing installed. Detected Ollama/LM Studio are offered as Advanced.
  const [selectedBackend, setSelectedBackend] = useState<string>(BUILTIN_BACKEND_ID)
  // Set when LM Studio is installed on the box but its embedded server is
  // not currently listening on :1234. Surfaces a "Start LM Studio server"
  // primary action instead of pushing the user through a redundant 570 MB
  // re-install. The install_lmstudio Tauri command is idempotent — it
  // detects the existing install and skips straight to bootstrap+server
  // start — so we route through the same code path either way; only the
  // UI labelling differs.
  const [lmstudioOfflineDetected, setLmstudioOfflineDetected] = useState(false)
  // Soft-detect: GGUFs in ~/.lmstudio/models/ even when we can't locate
  // lms.exe. Set when techx69-style users have LM Studio installed
  // system-wide (C:\Program Files\LM Studio) and the Rust path scan misses
  // it, but the canonical models dir is populated anyway. We surface a
  // "Start LM Studio server" CTA either way — the model count gives a
  // confidence cue in the offline-detected card.
  const [lmstudioModelCount, setLmstudioModelCount] = useState(0)

  /* ── Scan for backends ──────────────────────────────────── */
  const runDetection = async () => {
    setDetecting(true)
    setLmstudioOfflineDetected(false)
    setLmstudioModelCount(0)
    const backends = await detectLocalBackends()
    setDetectedBackends(backends)
    if (backends.length > 0 && !selectedBackend) {
      setSelectedBackend(backends[0].id)
    } else if (backends.length === 0 && isTauri) {
      // No live backend on any well-known port. Before we push the user
      // through a 570 MB LM-Studio re-install, ask the Rust side whether
      // LM Studio is actually present on disk — its embedded server may
      // just be turned off. lmstudio_server_status is cheap (a single
      // reqwest probe + a path check) and was added in the same sweep
      // that introduced this branch.
      //
      // v2.4.4 (Bug #2): the status payload now also includes
      // `models_detected` / `model_count` — set by scanning
      // ~/.lmstudio/models/ for GGUF files. We treat that as a strong
      // soft-detect signal: if the user has models in the canonical dir,
      // they obviously *have* LM Studio, regardless of whether our path
      // scan turned up lms.exe (techx69's system-wide install reproed this).
      try {
        const status = await backendCall<LmStudioServerStatus>('lmstudio_server_status')
        const offline = status?.lms_present && !status?.running
        const softDetect = status?.models_detected && !status?.running
        if (offline || softDetect) {
          setLmstudioOfflineDetected(true)
          setLmstudioModelCount(Number(status?.model_count) || 0)
        }
      } catch { /* command unavailable — ignore */ }
    }
    setDetecting(false)
  }

  return {
    detectedBackends,
    detecting,
    selectedBackend,
    setSelectedBackend,
    lmstudioOfflineDetected,
    lmstudioModelCount,
    runDetection,
  }
}
