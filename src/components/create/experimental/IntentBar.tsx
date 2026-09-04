import { Cloud } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { useUIStore, type CloudTeaserTarget } from '../../../stores/uiStore'
import { isIntentLocked, visibleIntents } from './intents'
import { isMlxImageHost } from '../../../api/mlx-image'
import { cn } from '../ui/cn'
import { ICON_SM } from '../../ui/icon-size'
import { WheelNav } from '../../ui/WheelNav'

// Jede Pille traegt ihre Beschriftung, immer. Bis 2.6.7 stand hier ein
// `max-width`-Aufklappen: nur die AKTIVE Pille zeigte ihren Namen, die
// uebrigen elf standen auf einer Maximalbreite von null, Deckkraft null und
// ohne waagerechtes Polster — die Hauptnavigation des ganzen Create-Bereichs
// war eine Reihe unbeschrifteter Icons, deren Namen nur der Hover-Tooltip
// verriet. Die kurzen Namen lagen dabei fertig im Datenmodell (`short` in
// intents.ts) und wurden von niemandem gelesen.
//
// (Die drei Utilities stehen hier bewusst ausgeschrieben statt als
// Klassennamen: Tailwind scannt diese Datei als Text und haette aus der
// Erklaerung wieder Regeln im ausgelieferten Bundle gemacht — siehe
// keine-klasse-aus-prosa.test.ts, der genau das gefangen hat.)
//
// Gemessen am 01.09.2026 im laufenden Fenster (Chromium 149, 1280x800,
// --ui-scale 1.15, also gerenderte Pixel), alle zwoelf Pillen der
// Cloud-/Windows-Leiste beschriftet:
//
//   nur Icons (Ist bis 2.6.7)     476 px
//   `short`  (Image … Motion)    1068 px   <- passt, 184 px Luft
//   `label`  (Edit / Image to Image, Remove Background, …)  1704 px
//   verfuegbar bei 1280px Fenster 1252 px
//
// Deshalb `short` und nicht `label`: die vollen Namen sprengen schon das
// Standardfenster um 452 px. `short` traegt bis hinunter zu ~1096 px
// Fensterbreite in einer Zeile.
//
// Darunter reicht der Platz nicht mehr. Nachgemessen bei 700 px Fenster:
// die Leiste laeuft 50 px ueber ihren Container hinaus, die Pillen stauchen
// NICHT, weil ein Flex-Item mit `whitespace-nowrap`-Inhalt und ohne `min-w-0`
// seine Mindestbreite behaelt. Der Ausgang waere die abgeschnittene letzte
// Pille am rechten Rand.
//
// Bis 2.6.8 war die Antwort darauf ein Umbruch in eine zweite Zeile. Seit dem
// Scrollrad (David, 03.09.2026) ist sie eine andere: die Leiste bleibt EINE
// Zeile und scrollt. Das loest dasselbe Problem und noch eins dazu, denn beim
// Umbruch sprang die Buehne darunter um 35,7 px, sobald das Fenster die
// Grenze kreuzte. Der aktive Eintrag steht immer in der Mitte, fuenf Nachbarn
// je Seite werden nach aussen blasser, und ein Klick faehrt das Ziel weich
// dorthin. Kein Ueberlauf, kein abgeschnittener Text, keine springende
// Hoehe.
//
// Der volle Name bleibt in `title`/`aria-label` — „Edit" auf der Pille,
// „Edit / Image to Image" fuer Hover und Screenreader.
//
// Die aktive Pille hebt sich weiter ueber Flaeche, Rand und Schriftfarbe ab
// (kein Framer-Layout, nichts kann auf dem Weg springen).
const EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]'

type TeaserIntent = Extract<CloudTeaserTarget, { surface: 'intent' }>['intent']

export function IntentBar() {
  const intent = useCreateStore((s) => s.intent())
  const setIntent = useCreateStore((s) => s.setIntent)
  const backend = useCreateStore((s) => s.backend)
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  // Every tool is always in the bar. The 2.5.8 lanes with hasLocalLane
  // (lipsync / music / extend / motion) are REAL local tabs — plain selectable
  // pills with NO cloud glyph (David 2026-07-19: the top row only carries a
  // cloud badge for the genuinely hosted-only tools). Only upscale, eraser and
  // character training (cloudOnly, no local backend) render as locked,
  // cloud-tagged pills in local mode; a tap opens the teaser sheet / plans gate.
  //
  // On an MLX Mac (no ComfyUI at all) those lanes have no local implementation
  // either, so they lock there too. Both rules live in intents.ts so they stay
  // pure + unit tested; this component only renders the verdict.
  const mlxHost = isMlxImageHost()
  const intents = visibleIntents(backend, mlxHost)

  return (
    <div
      role="radiogroup"
      aria-label="Create mode"
      // Bis 2.6.7 stand hier `transform: scale(0.763)` — eine dritte
      // Skalierungsschicht neben dem 18,4px-Wurzelmass und dem `zoom: 1.25`
      // der Sidebar. `transform` skaliert nur das BILD: die Leiste belegte
      // weiter ihre ungeschrumpfte Layoutbreite (gemessen 1084,7px fuer eine
      // sichtbar 827px breite Zeile) und jede Haarlinie darin wurde auf
      // 0,763px gemalt. Die 0,763 stehen jetzt in den Groessen selbst:
      // jede rem-Laenge dieser Leiste ist ihr altes Mass mal 0,763, in
      // ganzen Pixeln des 16px-Rasters (36px Pille -> 28px, 16px Icon ->
      // 12px = ICON_SM, 12px Label -> 9px).
      className="px-3 py-[1.5px] [--text-control:9px]"
    >
      {/* David, 04.09.2026: „das selbe bei create tab ... hard in der mitte."
          `mx-auto` auf einem Blockkasten setzt seine Mitte auf die Mitte des
          umgebenden Kastens, und zwar unabhaengig davon, was sonst in der
          Leiste steht. Die Kopfzeile braucht dafuer eine absolute Position,
          weil dort links und rechts etwas NEBEN dem Rad steht; hier steht
          nichts daneben, und dann ist der zentrierte Blockkasten die
          einfachere Fassung derselben Zusage.

          62rem und nicht die volle Breite: fuenf Nachbarn je Seite sind elf
          Pillen, gemessen rund 979px. Ohne Deckel stuenden im breiten Fenster
          alle zwoelf nebeneinander, ein Klick bewegte nichts, und der Verlauf
          waere Dekoration statt Orientierung. */}
      <WheelNav
        activeIndex={intents.findIndex((m) => m.id === intent)}
        radius={5}
        reihenClass="gap-x-[3px]"
        className="mx-auto w-full max-w-[62rem]"
      >
      {intents.map((meta) => {
        const locked = isIntentLocked(meta, backend, mlxHost)
        const selected = !locked && intent === meta.id
        const Icon = meta.icon
        return (
          <button
            key={meta.id}
            role="radio"
            aria-checked={selected}
            aria-label={locked ? `${meta.label}, runs on LU Cloud` : meta.label}
            title={locked ? `${meta.label}, runs on LU Cloud` : meta.label}
            onClick={() =>
              locked
                ? setCloudTeaser({ surface: 'intent', intent: meta.id as TeaserIntent })
                : setIntent(meta.id)
            }
            className={cn(
              'relative flex items-center h-7 rounded-full border transition-[background-color,border-color,box-shadow,color] duration-200',
              EASE,
              selected
                ? 'bg-white/[0.11] border-white/20 shadow-sm text-white'
                : locked
                  ? 'border-transparent text-gray-600 hover:text-gray-400 hover:bg-white/[0.03]'
                  : 'border-transparent text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]',
            )}
          >
            <span className="grid place-items-center w-7 h-7 shrink-0">
              <Icon size={ICON_SM} />
            </span>
            {locked && (
              // Brighter, theme-aware cloud tag: violet-300/80 was near
              // invisible on light backgrounds and easy to miss on dark.
              <Cloud
                size={8}
                className="absolute top-[1.5px] right-[1.5px] text-violet-500 dark:text-violet-200"
                aria-hidden
              />
            )}
            <span className="whitespace-nowrap t-control pl-[3px] pr-[10.5px]">
              {meta.short}
            </span>
          </button>
        )
      })}
      </WheelNav>
    </div>
  )
}
