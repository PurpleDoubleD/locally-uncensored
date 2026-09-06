/**
 * Die vier Installer des Assistenten — und der EINE Takt, der sie zaehlt.
 *
 * Warum es dieses Modul gibt (und nicht vier Module, eins je Schritt):
 * Ollama, LM Studio, ComfyUI und Python sind vier Anzeigen DERSELBEN
 * Zustandsmaschine (AS-09, `./installer-state.ts`), und sie teilen sich eine
 * Uhr. Eine Zerlegung „pro Schritt" haette genau das wieder auseinandergerissen:
 * Ollama und LM Studio wohnen im Backend-Schritt, ComfyUI und Python im
 * ComfyUI-Schritt — vier `useReducer` auf zwei Dateien, und die eine Uhr
 * waere zwangslaeufig wieder zu zweien geworden, weil kein Schritt die
 * Startzeit des anderen sieht. Genau der Zustand, den AS-09 abgeraeumt hat
 * (vier `setInterval`, vier `elapsed`-States).
 *
 * Deshalb liegt die Flotte HIER, oberhalb der Schritte, und die Schritte
 * bekommen nur die Anzeige, die sie zeichnen. Der Schnitt folgt dem geteilten
 * Zustand, nicht der Bildschirmfolge.
 *
 * Was das Modul NICHT tut: es startet nichts und es pollt nichts. Welcher
 * Tauri-Befehl gerufen und wie sein Status gelesen wird, gehoert zu dem
 * Schritt, der den Knopf zeichnet — das ist pro Installer verschieden und
 * waere hier vier Sonderfaelle in einer Datei, die gerade dafuer da ist,
 * dass es keine vier mehr gibt.
 */
import { useEffect, useReducer, useState, type Dispatch } from 'react'
import {
  installerReducer, IDLE_INSTALLER, elapsedSeconds,
  type InstallerState, type InstallerAction,
} from './installer-state'

export interface InstallerFleet {
  ollama: InstallerState
  ollamaDo: Dispatch<InstallerAction>
  lmstudio: InstallerState
  lmstudioDo: Dispatch<InstallerAction>
  comfyInstall: InstallerState
  comfyDo: Dispatch<InstallerAction>
  pythonInstall: InstallerState
  pythonDo: Dispatch<InstallerAction>
  /** Laufzeit einer Installation in Sekunden, aus dem gemeinsamen Takt. */
  secondsOf: (startedAt: number | null) => number
}

export function useInstallerFleet(): InstallerFleet {
  // AS-09: hier standen acht `useState` fuer EINE Zustandsmaschine —
  // installing, logs, error, downloadProgress, downloadTotal, downloadSpeed
  // plus installStartTime und elapsed weiter unten. Dieselbe Maschine fuehrten
  // Ollama, LM Studio und der Python-Installer je noch einmal. Sie steht jetzt
  // in ./installer-state.ts, einmal und geprueft.
  const [comfyInstall, comfyDo] = useReducer(installerReducer, IDLE_INSTALLER)
  // P14: Python install state. On a fresh Windows box `python` is the
  // Microsoft Store stub which exit-1's `pip install`. The ComfyUI install
  // pre-flight runs `python_check`; if Python is missing we kick off
  // `install_python` (winget Python.Python.3.12) and poll its status here
  // before re-firing `install_comfyui`.
  // Dieselbe Maschine. `setPythonReady` war dabei ein Schreibzugriff ohne
  // Leser (`const [, setPythonReady]`) — im Reducer ist „fertig" eine Phase,
  // also gibt es den toten Halbzustand nicht mehr.
  const [pythonInstall, pythonDo] = useReducer(installerReducer, IDLE_INSTALLER)
  // Ollama und LM Studio — der Kommentar hier sagte es vorher selbst:
  // „same shape as Ollama". Zwanzig `useState` fuer zweimal dieselbe Maschine.
  const [ollama, ollamaDo] = useReducer(installerReducer, IDLE_INSTALLER)
  const [lmstudio, lmstudioDo] = useReducer(installerReducer, IDLE_INSTALLER)

  // Der EINE Takt fuer alle vier Anzeigen. `elapsed` war viermal ein eigener
  // `useState` mit einem eigenen `setInterval`, obwohl es nichts anderes ist
  // als `jetzt − startedAt`. Gespeichert wird jetzt nur noch das „jetzt",
  // gerechnet wird beim Rendern (elapsedSeconds in ./installer-state.ts).
  const [now, setNow] = useState(() => Date.now())
  const secondsOf = (startedAt: number | null) => elapsedSeconds(startedAt, now)

  // EIN Takt fuer alle vier Installer statt vier Intervallen (AS-09). Er
  // laeuft nur, solange ueberhaupt einer laeuft, und er speichert die Uhr,
  // nicht die vier daraus abgeleiteten Sekundenzaehler.
  //
  // Der Python-Fall ist der, der die Laufzeit ueberhaupt sichtbar macht
  // (P14): winget zieht den Python-3.12-Installer (~30 MB) und faehrt ihn
  // still durch — an einem normalen Anschluss 30–60 s, an einem langsamen
  // ein paar Minuten.
  const anyStartedAt = comfyInstall.startedAt ?? ollama.startedAt ?? lmstudio.startedAt ?? pythonInstall.startedAt
  useEffect(() => {
    if (anyStartedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyStartedAt])

  return {
    ollama, ollamaDo,
    lmstudio, lmstudioDo,
    comfyInstall, comfyDo,
    pythonInstall, pythonDo,
    secondsOf,
  }
}
