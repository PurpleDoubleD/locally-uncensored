import { Cloud } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { useUIStore, type CloudTeaserTarget } from '../../../stores/uiStore'
import { isIntentLocked, visibleIntents } from './intents'
import { isMlxImageHost } from '../../../api/mlx-image'
import { cn } from '../ui/cn'
import { ICON_SM } from '../../ui/icon-size'

// Pure-CSS expand: no Framer layout projection anywhere, so nothing can snap or
// jitter on settle. The label opens via a `max-width` transition (collapses
// reliably to 0 — unlike grid `0fr`, which keeps its min-content floor — and
// interpolates as a plain length, so it's always smooth). The active pill
// cross-fades via colour/shadow; neighbours slide on natural flex reflow.
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
      className="flex items-center justify-center gap-[3px] px-3 py-[1.5px] [--text-control:9px]"
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
            <span
              className={cn(
                'overflow-hidden whitespace-nowrap min-w-0 t-control transition-[max-width,opacity,padding] duration-200',
                EASE,
                selected ? 'max-w-[114px] opacity-100 pl-[3px] pr-[10.5px]' : 'max-w-0 opacity-0 px-0',
              )}
            >
              {meta.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
