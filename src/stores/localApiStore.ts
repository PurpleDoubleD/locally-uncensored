/**
 * Der Zustand der lokalen Modell-API auf der Oberflaeche.
 *
 * Der Server selbst lebt in Rust (src-tauri/src/commands/local_api.rs). Dieser
 * Store haelt nur, was der Nutzer eingestellt hat, und ruft die vier Befehle
 * auf.
 *
 * ── WARUM DAS TOKEN HIER LIEGT UND NICHT IM SCHLUESSELBUND ─────────────────
 *
 * Der Schluesselbund (commands/secret.rs) gibt es nur auf macOS und Windows;
 * auf Linux faellt die App auf den verschleierten localStorage zurueck, und
 * `check_account` fuehrt ausserdem eine feste Kontenliste. Ein zweiter
 * Aufbewahrungsweg fuer EIN Token waere eine zweite Stelle, an der er kaputt
 * gehen kann. Also derselbe Weg wie fuer die anderen Einstellungen.
 *
 * Das Token ist ausserdem kein fremdes Geheimnis: es gehoert diesem Rechner,
 * gilt nur fuer ihn, und der Nutzer soll es sehen und kopieren koennen. Wer
 * die Einstellungsdatei lesen kann, kann ohnehin auch 127.0.0.1 erreichen.
 *
 * `laeuft` wird NICHT mitgespeichert. Ob der Server laeuft, weiss nur Rust —
 * ein gespeichertes `true` waere nach einem Neustart eine Behauptung.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { backendCall } from '../api/backend'
import { LOCAL_API_DEFAULT_PORT, kannStarten, parseCorsOrigins } from '../lib/local-api'

interface LocalApiState {
  port: number
  lan: boolean
  token: string
  /**
   * Herkuenfte, die im Browser mitlesen duerfen. Leer heisst zu — siehe
   * `cors_erlaubt` in local_api.rs. Der Rohtext des Feldes wird NICHT
   * gespeichert, nur das gepruefte Ergebnis: was hier steht, ist genau das,
   * was der Server bekommt.
   */
  corsOrigins: string[]
  /** Nur zur Laufzeit. Kommt aus `local_api_status`, nie aus dem Speicher. */
  laeuft: boolean
  adresse: string | null
  fehler: string | null

  setPort: (p: number) => void
  setLan: (v: boolean) => void
  setCors: (text: string) => void
  neuesToken: () => Promise<void>
  starten: () => Promise<void>
  stoppen: () => Promise<void>
  auffrischen: () => Promise<void>
}

export const useLocalApiStore = create<LocalApiState>()(
  persist(
    (set, get) => ({
      port: LOCAL_API_DEFAULT_PORT,
      lan: false,
      token: '',
      corsOrigins: [],
      laeuft: false,
      adresse: null,
      fehler: null,

      setPort: (p) => set({ port: p }),
      setLan: (v) => set({ lan: v }),
      setCors: (text) => set({ corsOrigins: parseCorsOrigins(text) }),

      neuesToken: async () => {
        try {
          const t = await backendCall<string>('local_api_new_token')
          set({ token: t, fehler: null })
        } catch (e) {
          set({ fehler: String(e) })
        }
      },

      starten: async () => {
        const { token, port, lan, corsOrigins } = get()
        const urteil = kannStarten(token, port)
        if (!urteil.ok) { set({ fehler: urteil.grund }); return }
        try {
          const r = await backendCall<{ address?: string }>('start_local_api', {
            port, lan, token, corsOrigins,
          })
          set({ laeuft: true, adresse: r?.address ?? null, fehler: null })
        } catch (e) {
          set({ laeuft: false, fehler: String(e) })
        }
      },

      stoppen: async () => {
        try {
          await backendCall('stop_local_api')
        } catch { /* ein nicht laufender Server ist kein Fehler */ }
        set({ laeuft: false, adresse: null })
      },

      auffrischen: async () => {
        try {
          const r = await backendCall<{ running?: boolean; address?: string }>('local_api_status')
          set({ laeuft: !!r?.running, adresse: r?.address ?? null })
        } catch {
          set({ laeuft: false, adresse: null })
        }
      },
    }),
    {
      name: 'lu-local-api',
      // Quotensicher wie jeder andere localStorage-Store dieses Hauses. Es
      // sind vier kleine Felder, aber die Quote ist geteilt: laeuft sie durch
      // die Chatverlaeufe voll, wuerfe ein nacktes `persist` hier eine
      // QuotaExceededError bis in den Aufrufer — und die Einstellung sperrte
      // sich zu, ohne zu sagen warum.
      storage: safeJSONStorage(),
      // Genau die vier Einstellungen. `laeuft`, `adresse` und `fehler` sind
      // Laufzeit und gehoeren nicht in die Datei — siehe Kopfkommentar.
      partialize: (s) => ({ port: s.port, lan: s.lan, token: s.token, corsOrigins: s.corsOrigins }),
    },
  ),
)
