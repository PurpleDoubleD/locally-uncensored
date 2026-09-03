/**
 * „Ist es da? Und wenn nicht, installier es." — die Zustandsmaschine hinter
 * Speech-to-Text und Text-to-Speech in den Einstellungen.
 *
 * ── Warum diese Datei existiert (AS-09, zweite Haelfte) ───────────────────
 *
 * `SettingsPage.tsx` ist, anders als `Onboarding.tsx`, laengst zerlegt: neun
 * Komponenten in einer Datei, die groesste (`ComfyUISettings`) mit 16
 * `useState`, die Wurzel `SettingsPage()` mit 13. Von diesen 13 gehoerten
 * elf einem einzigen Abschnitt — „Speech" — und acht davon waren zweimal
 * dasselbe:
 *
 *     whisperStatus · whisperLoading · whisperInstalling · whisperInstallError
 *     ttsStatus     · ttsLoading     · ttsInstalling     · ttsInstallError
 *
 * Also wieder kein Zaehlproblem, sondern eine Wiederholung. Hier steht sie
 * einmal, ueber dem Typ der jeweiligen Probe generisch, und ohne React —
 * damit pruefbar in einer Umgebung ohne DOM.
 *
 * Der zweite Gewinn liegt nicht in der Zahl: die drei Proben (`whisper`,
 * `tts`, Stimmenliste) liefen im Mount-Effekt von `SettingsPage` und damit
 * bei JEDEM Oeffnen der Einstellungen — auch auf dem Tab „General", wo der
 * Abschnitt gar nicht gerendert wird. Mit dem Abschnitt als eigener
 * Komponente laufen sie, wenn er auf dem Bildschirm ist.
 */

/** Ergebnis einer Verfuegbarkeitsprobe plus der Zustand ihrer Installation. */
export interface ProbeInstall<T> {
  /** Das Probenergebnis, `null` solange nichts vorliegt. */
  probe: T | null
  /** Die Probe laeuft gerade. */
  loading: boolean
  /** Die Installation laeuft gerade. */
  installing: boolean
  /** Letzter Installationsfehler, `null` wenn keiner. */
  installError: string | null
}

export type ProbeAction<T> =
  /** Probe angestossen. */
  | { type: 'probing' }
  /** Probe zurueck. */
  | { type: 'probed'; probe: T }
  /**
   * Probe fehlgeschlagen. Das Ergebnis bleibt, was es war — genau wie
   * vorher, wo `setStatus` im `.then` stand und `setLoading(false)` im
   * `.finally`: ein Fehlschlag liess den letzten bekannten Stand stehen.
   */
  | { type: 'probeFailed' }
  /** Installation angestossen; loescht den Fehler des vorigen Versuchs. */
  | { type: 'installStart' }
  /** Installation gescheitert (die Probe danach laeuft trotzdem). */
  | { type: 'installFailed'; error: string }
  /** Installationslauf beendet — erfolgreich oder nicht; die Probe entscheidet. */
  | { type: 'installDone' }

export function initialProbe<T>(): ProbeInstall<T> {
  // `loading: true` ist der Ausgangszustand, nicht `false`: die Probe wird im
  // selben Zug angestossen, in dem die Komponente entsteht, und ein kurzes
  // rotes Kreuz vor dem ersten Ergebnis waere eine Falschaussage.
  return { probe: null, loading: true, installing: false, installError: null }
}

/**
 * Erzeugt den Reducer fuer einen konkreten Probentyp. Die Fabrik existiert
 * nur, damit die Aufrufstelle `useReducer(whisperReducer, initialProbe())`
 * schreiben kann, ohne eine generische Funktion casten zu muessen.
 */
export function makeProbeReducer<T>() {
  return function probeInstallReducer(state: ProbeInstall<T>, action: ProbeAction<T>): ProbeInstall<T> {
    switch (action.type) {
      case 'probing':
        return { ...state, loading: true }
      case 'probed':
        return { ...state, loading: false, probe: action.probe }
      case 'probeFailed':
        return { ...state, loading: false }
      case 'installStart':
        return { ...state, installing: true, installError: null }
      case 'installFailed':
        return { ...state, installError: action.error }
      case 'installDone':
        return { ...state, installing: false }
    }
  }
}

/**
 * „Der Knopf ‚Herunterladen und installieren' gehoert hierhin." — die
 * Bedingung, die im JSX viermal als `!loading && probe && !probe.available`
 * ausgeschrieben stand.
 */
export function needsInstall(s: ProbeInstall<{ available: boolean }>): boolean {
  return !s.loading && s.probe !== null && !s.probe.available
}

/** „Die Erklaerzeile darunter gehoert hierhin." */
export function showsHint(s: ProbeInstall<{ available: boolean }>): boolean {
  return needsInstall(s) && !s.installing && s.installError === null
}
