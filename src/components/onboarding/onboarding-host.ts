/**
 * Laeuft der Assistent im Desktop-Fenster oder in einer Browser-Vorschau?
 *
 * Warum das ein eigenes Modul ist und keine drei Kopien: nach der Zerlegung
 * fragen DREI Dateien danach — die Schale (Fensterknoepfe, `set_onboarding_done`
 * am Ende), der Modellschritt (Ollama vor dem Pull anwerfen) und der
 * Einbettungsschritt (der Pull braucht die Desktop-App). Drei Kopien EINES
 * Praedikats sind genau das Muster, das AS-09 aus dieser Datei geraeumt hat.
 *
 * Warum NICHT `isTauri()` aus `api/backend.ts`: das ist ein anderes Praedikat.
 * Jenes akzeptiert zusaetzlich das alte Tauri-v1-Global `__TAURI__`; der
 * Assistent hat seit jeher nur auf `__TAURI_INTERNALS__` geprueft. Die beiden
 * gegeneinander zu tauschen waere eine Verhaltensaenderung, keine Aufraeumung —
 * also bleibt hier der strenge v2-Test stehen, und dieser Kommentar sagt, dass
 * der Unterschied bekannt ist und nicht uebersehen wurde.
 *
 * Einmal beim Laden ausgewertet, nicht pro Aufruf: so stand es vorher auch,
 * und ein Fenster wechselt seinen Wirt nicht mitten im Assistenten.
 */
export const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
