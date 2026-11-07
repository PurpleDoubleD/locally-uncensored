// Der Preis eines Studio-Laufs im Create-Tab.
//
// Port aus dem Web (components/create/experimental/useStudioPrice.ts), mit
// EINEM bewussten Unterschied (Portplan P7, Abschnitt 5 Punkt 3): das Web
// faellt bei jedem Fehler still auf die eigene Formel zurueck und laesst den
// Startknopf offen ("die eigene Formel traegt die Anzeige weiter"). Der
// Desktop-Client spricht den Anbieter zum ERSTEN Mal ueberhaupt ueber CORS an
// (P0 im Web-Repo ist die Vorbedingung dafuer, siehe studio.ts) und darf
// deshalb nicht optimistisch sein: bleibt der Server unerreichbar oder zu alt,
// bleibt der Startknopf gesperrt und zeigt den festen englischen Text aus
// studio.ts, statt einen Lauf zuzulassen, den der Server beim Buchen doch
// ablehnt (Portplan Abschnitt 7, Risiko 1+2).
//
// Auf der LOKALEN Spur (ComfyUI/MLX) darf dieser Hook keinen einzigen
// Netzabruf ausloesen: `model` ist dort immer undefined (Composer uebergibt
// `studioPick`, das nur bei `backend === 'cloud'` gesetzt wird), und der
// Effekt unten kehrt in dem Fall sofort um, ohne `studioQuote()` zu rufen.
// Siehe useCloudCreate-studio.test.ts, Fall "no network call on the local
// lane".
//
// Review A1/B3 (Runde 2, 20.09.2026): `price.mode` 'input'/'both' Modelle
// (pricesByInput()) bleiben hier weiterhin bei der Formel-Vorschau, OHNE
// `studioQuote()`, das ist bewusst, nicht die Luecke, die B3 fand. Diese
// Modelle rechnen serverseitig aus der GEMESSENEN Laenge der hochgeladenen
// Datei; eine echte Server-Quote vor dem Klick wuerde die Datei hochladen,
// bevor die Kundschaft ueberhaupt "Create" gedrueckt hat, fuer eine Zahl, die
// sie vielleicht nie sieht. Die Geldwahrheit liegt fuer diese 17 Modelle
// stattdessen in `useCloudCreate.ts`: `generate()` ruft `studioQuote()` MIT
// den bereits fuer den Lauf hochgeladenen Pfaden, unmittelbar vor der
// Buchung, und setzt genau diese Zahl als `max_credits`, kein Upload extra,
// kein Kredit ohne bestaetigte Zahl. Der Startknopf bleibt fuer diese 17
// deshalb nicht wegen eines fehlenden Preises gesperrt (er war es nie fuer
// price.mode 'output'/'characters' Modelle vor dem ersten Tastendruck
// entweder), sondern die Buchung selbst kann nie mehr Kredite abrechnen, als
// die Quote unmittelbar davor bestaetigt.

import { useEffect, useRef, useState } from 'react'
import { createStudioCost, pricesByInput, startImageCount } from '../../../lib/render/create-studio'
import { studioRequiredParams } from '../../../lib/render/studio-roles'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { studioQuote } from '../../../api/cloud/studio'
import { StudioQuoteChangedError } from '../../../api/cloud/studio'
import { CloudJobError } from '../../../api/cloud/client'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'

/** Laenge einer Ton- oder Bildspur, im Browser gemessen. */
export function mediaSeconds(url: string, kind: 'audio' | 'video'): Promise<number | undefined> {
  return new Promise((resolve) => {
    const el = document.createElement(kind)
    const done = (v?: number) => { el.src = ''; resolve(v) }
    el.preload = 'metadata'
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined)
    el.onerror = () => done(undefined)
    // Ein Medium, das sich nicht oeffnen laesst, darf die Anzeige nicht anhalten.
    setTimeout(() => done(undefined), 8000)
    el.src = url
  })
}

export interface StudioPrice {
  credits: number
  /** Wahr, sobald die Zahl vom Anbieter bestaetigt ist. */
  live: boolean
  /** Gesetzt, wenn der Anbieter nicht erreichbar ist oder der Server das
   *  Studio noch nicht kennt (siehe studio.ts, OLDER_SERVER_MESSAGE). Solange
   *  das steht, darf der Startknopf nicht freigeben, Portplan Abschnitt 5. */
  error?: string
}

// Review B4 (Runde 3, 20.09.2026): the price key used to carry the prompt's
// LIVE length, so every single keystroke changed `key`, restarted the (only
// 500ms) debounce, and fired a fresh studioQuote() once typing paused for
// half a second, word by word. Measured: a slow but ordinary typist (600ms
// per character) triggered one call per character, 48 calls for a 48-char
// prompt, against a server limit of 20/minute.
//
// The length genuinely belongs in the price for `price.mode: 'characters'`
// models (studio-contract.ts's `studioCredits`, `seconds = promptLength/100`
// for that mode only; checked against the server worker's own
// `studioCredits()`, same formula). It cannot simply be dropped from the
// key. What it needs is its OWN, much longer debounce, separate from the
// 500ms the other fields (model/options/seconds) already have: a real pause
// in typing, not a half-second gap between characters. `debouncedPromptLen`
// only updates 1800ms after the prompt stops changing, so continuous typing
// (even a slow, sustained 600ms/char rhythm with no individual gap that
// long) never touches `key` until the customer actually stops.
//
// Review B5 (Runde 4, 20.09.2026): the debounce itself lives in
// useDebouncedValue.ts now, shared with PresetWorkshop.tsx's `priceKey`
// (the same disease, measured there too, see that file), one function
// instead of two copies that could drift apart. Exported so the Workshop
// uses the SAME constant, not a second guess at the right number.
export const PROMPT_DEBOUNCE_MS = 1800

export function useStudioPrice(
  model: string | undefined,
  options: Record<string, unknown>,
  prompt: string,
  seconds: number | undefined,
  /** Fotos der Referenzleiste neben dem Standbild. */
  extraPhotos = 0,
  /** Bilder, die einzeln kosten (price.perReference, Swap Character). */
  referenceCount = 0,
): StudioPrice | null {
  // Die Bildzahl, die der Start wirklich schickt: der Anbieter rechnet sie ein
  // (MiniMax H3 Reference, je Bild). Ohne sie bliebe der Vorab-Preis aus.
  const images = model ? startImageCount(model, extraPhotos) : undefined
  // Ein Modell, das ein Pflichtbild liest, laesst sich vor dem Hochladen nur bei
  // einem Server bepreisen, der `quote_images` kennt (studio-quote, 02.10.2026).
  // Dass ein Server das kann, sagt er selbst: sein Katalog fuehrt Stufen. Ein
  // aelterer Server wuerde ohne Datei mit 400 antworten, und das sperrte den
  // Startknopf. Dort steht die Formel-Vorschau, und die Buchung holt ihre
  // bestaetigte Zahl nach dem Hochladen (useCloudCreate), wie bei den Modellen,
  // die nach der Dateilaenge abrechnen.
  const quotesImages = useCloudCatalogStore((s) => s.models.some((m) => m.tier !== undefined))
  const needsUpload = model ? images !== undefined && studioRequiredParams(model).length > 0 : false
  const [live, setLive] = useState<{ key: string; credits: number } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const debouncedPromptLen = useDebouncedValue(prompt.length, PROMPT_DEBOUNCE_MS)
  const key = model ? JSON.stringify([model, options, debouncedPromptLen, seconds, images, quotesImages, referenceCount]) : ''

  useEffect(() => {
    abort.current?.abort()
    // Kein Modell (lokale Spur, oder Wolke ohne Studio-Wahl): kein Abruf.
    // Ein Modell, dessen Preis an einer hochgeladenen Datei haengt, wird erst
    // MIT der Datei gebucht (useCloudCreate), hier reicht die Formel.
    if (!model || pricesByInput(model) || (needsUpload && !quotesImages)) { setLive(null); setError(null); return }
    const controller = new AbortController()
    abort.current = controller
    const timer = setTimeout(async () => {
      try {
        const res = await studioQuote(model, prompt, { op: 'studio', studio_options: options }, quotesImages ? images : undefined)
        if (controller.signal.aborted) return
        setLive({ key, credits: res.credits })
        setError(null)
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof StudioQuoteChangedError) {
          // 409 quote_changed: zeigt den neuen Preis, statt still weiter die
          // alte Formel zu zeigen oder gar neu zu buchen.
          setLive({ key, credits: err.credits })
          setError(null)
          return
        }
        // Review B4: only a genuine version gap (404 "no route yet", or 0
        // "could not reach the server at all", studio.ts's OLDER_SERVER_MESSAGE
        // mapping) locks the start button, the case this hook was built to
        // guard (Portplan Abschnitt 5/7). A 429 (the quote rate limit,
        // "Please wait before requesting another quote") is not a version
        // gap and not a money risk any more: useCloudCreate's generate()
        // reconfirms a fresh quote right before booking regardless (Review
        // A1/B3, Runde 2), so a missing LIVE number here costs nothing but
        // the live badge. It falls back to the same formula preview every
        // price.mode 'input'/'both' model already shows, quietly, and
        // leaves Generate enabled. Any other status (401, 400, ...) is
        // unexpected here and keeps the old blocking behavior rather than
        // guess it is safe.
        if (err instanceof CloudJobError && err.status === 429) {
          setLive(null)
          setError(null)
          return
        }
        if (err instanceof CloudJobError) {
          setError({ key, message: err.message })
          setLive(null)
          return
        }
        // Unerwarteter Fehler (kein CloudJobError): nicht verschlucken, aber
        // auch nicht den Startknopf sperren, dafuer fehlt die Textgrundlage.
        setLive(null)
        setError(null)
      }
    }, 500)
    return () => { clearTimeout(timer); controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!model) return null
  if (error && error.key === key) {
    return { credits: createStudioCost(model, options, Array.from(prompt).length, seconds, images ?? 1, referenceCount), live: false, error: error.message }
  }
  if (live && live.key === key) return { credits: live.credits, live: true }
  return { credits: createStudioCost(model, options, Array.from(prompt).length, seconds, images ?? 1, referenceCount), live: false }
}
