import { Trash2, Info, MessageSquare, Image, Video, Loader2, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { formatBytes } from '../../lib/formatters'
import { BenchmarkButton } from './ModelBenchmark'
import { ContextMenu } from '../ui/ContextMenu'
import { buildModelCardMenu, type ModelMenuHandlers } from '../ui/menu-actions'
import { displayModelName } from '../../api/providers/model-name'
import { splitForMiddleEllipsis } from '../../lib/model-label'
import { isBuiltinEngineEntry } from '../../lib/lmstudio-match'
import type { AIModel } from '../../types/models'
import { fileFormat } from '../../lib/model-file-format'
import { ICON_SM } from '../ui/icon-size'
import { modelSkin } from './skin'
import { AddImageInput } from './AddImageInput'

interface Props {
  model: AIModel
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onInfo: () => void
  /** Tooltip of the Details button, when the row has more to say there. */
  infoTitle?: string
  canDelete?: boolean
  /**
   * A16 (A14-4a): the Use button the 2.6.8 notes promise twice on this tile.
   *
   * The Windows counter-check found only Bench and Details here. The tile
   * itself was the switch, which works and is invisible: nothing on the row
   * said that clicking it would move the chat backend and load the model, so
   * the counter-check read the notes as broken and the button as missing.
   *
   * Passed only for rows where the word means something, an LU Engine row that
   * is not already the active one, and it goes through `onSelect`, the same
   * path the tile click takes.
   */
  onUse?: () => void
  /**
   * Die LU Engine bedient gerade gar nichts.
   *
   * Persona P2, 04.09.2026: nach einem `Stop-Process` auf den Engine-Prozess
   * behielt genau das Modell, das lief, sein ACTIVE und verlor seinen
   * Use-Knopf, 40 bzw. 90 Sekunden lang unveraendert, waehrend das
   * Einstellungsfenster den Tod schon nach 2 Sekunden meldete. Nach einem
   * Absturz war ausgerechnet das zuletzt benutzte Modell das einzige, das man
   * von hier aus nicht neu starten konnte.
   *
   * Die Angabe gilt fuer die ganze Seite, denn es gibt nur die eine Engine.
   * Was sie ueber DIESE Zeile aussagt, entscheidet die Karte selbst, siehe
   * `engineStopped` weiter unten.
   */
  engineStopped?: boolean
  /** While that swap runs. The engine can take seconds to load a cold GGUF. */
  useBusy?: boolean
  /** A14: open the refusal-removal tool for this file. Passed only for LU
   *  Engine rows whose original weights the file names. */
  onRemoveRefusals?: () => void
  /** W33: show a ComfyUI file in its folder (right click). */
  onReveal?: () => void
}

// The glyph of each kind of model. Its tone, like every other class of this
// row, comes from the face the page wears (skin/classic.tsx, skin/mac.tsx):
// the row is one structure with two looks.
const TYPE_CONFIG = {
  text: { label: 'Text', icon: MessageSquare },
  image: { label: 'Image', icon: Image },
  video: { label: 'Video', icon: Video },
}

/** The Create tab a specialised video file runs in. These files are not
 *  offered in Create's Video tab, so a row that just says "Video" sent the
 *  Discord reporter of 15.10.2026 looking there for his Wan 2.2 Animate
 *  model. Everything else answers null and draws nothing. */
export function createTabForArchitecture(architecture: string | undefined): string | null {
  if (architecture === 'wananimate' || architecture === 'wanvace') return 'Motion Control'
  if (architecture === 'wans2v') return 'Talking Character'
  return null
}

export function ModelCard({ model, isActive, onSelect, onDelete, onInfo, infoTitle, canDelete = true, onUse, useBusy = false, engineStopped: luEngineRuht = false, onRemoveRefusals, onReveal }: Props) {
  const typeInfo = TYPE_CONFIG[model.type] || TYPE_CONFIG.text
  const TypeIcon = typeInfo.icon
  const look = modelSkin().card
  const kind = model.type in TYPE_CONFIG ? model.type : 'text'
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // EIN Satz Aktionen fuer die Karte. Die sichtbaren Knoepfe unten lesen aus
  // diesem Objekt, das Kontextmenue bekommt dasselbe Objekt gereicht — es gibt
  // also keinen zweiten Aufrufweg, der irgendwann anders werden koennte.
  const actions: ModelMenuHandlers = { select: onSelect, info: onInfo, remove: onDelete, removeRefusals: onRemoveRefusals, reveal: onReveal }
  const refusalsRemoved = 'refusalsRemoved' in model && model.refusalsRemoved === true
  // Fremde Kennungen tragen Pfadteile und Dateiendungen mit sich, die kein
  // Kunde gewaehlt hat. Der Name selbst bleibt unangetastet (lib/model-label).
  const { head: nameKopf, tail: nameEnde } = splitForMiddleEllipsis(displayModelName(model.name))
  // Was die stehende Engine ueber DIESE Zeile aussagt.
  //
  // Sie bedient nur ihre eigenen Zeilen. Ollama und LM Studio antworten
  // weiter, waehrend sie ruht: eine Ollama-Kachel mit "Not running" waere eine
  // Falschmeldung ueber ein laufendes Backend, und sie traf genau den Kunden,
  // der die LU Engine nie gestartet hat. Wessen Zeile das ist, beantwortet
  // dieselbe Funktion, die auf der Models-Seite den Use-Knopf verteilt.
  const engineStopped = luEngineRuht && isBuiltinEngineEntry(model)

  return (
    <>
    <div
      onClick={actions.select}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      className={look.row(isActive)}
    >
      {/* Type icon */}
      <TypeIcon size={look.typeIconSize} className={look.typeIcon(kind, isActive)} />

      {/* Name, grows to fill the row (single-line, LM-Studio style).
          Ohne das `openai::` davor: das ist unser Steckplatzname, kein Name,
          den ein Kunde je gewaehlt hat. Persona P5, 03./04.09.2026: "Fuer
          einen Kunden, der LU Engine benutzt und mit OpenAI nichts zu tun
          hat, ist das verwirrend."

          Auch nicht im title. Da stand er bis zur Nachpruefung G3 am
          04.09.2026, mit der Begruendung, ein Fehlerbericht brauche ihn. Der
          Tester hat ihn dort an neun Kacheln gefunden, und die Zusage sagt
          nirgends. Fuer den Fehlerbericht steht der volle Name im Log, wo er
          hingehoert, und nicht unter dem Mauszeiger eines Kunden. */}
      <span
        title={displayModelName(model.name)}
        className={look.name}
      >
        {/* Gekuerzt wird in der MITTE. Gegenprobe G1, 04.09.2026: am Ende
            gekuerzt sahen `qwen2.5-0.5b-instruct@q4_k_m` und
            `qwen2.5-0.5b-instruct@q8_0` gleich aus, obwohl es zwei
            verschiedene Modelle sind. */}
        <span className="truncate">{nameKopf}</span>
        {nameEnde && <span className="shrink-0">{nameEnde}</span>}
      </span>

      {/* Gegenprobe G2, 04.09.2026: nach dem Tod der Engine trug die Kachel
          weiter ACTIVE und sah ansonsten aus wie jede gesunde Kachel. "Es gibt
          keinen Zustand gestoppt, abgestuerzt oder aehnliches, keinen
          Fehlertext, keine eigene Farbe, keinen eigenen Knopf." Auf derselben
          Maschine meldete Settings binnen einer Sekunde "Engine not running".
          Das Abzeichen sagt jetzt dasselbe, und in derselben Sprache. */}
      {isActive && (
        engineStopped ? (
          <span
            data-testid="model-card-stopped"
            title="This is your pick, but the LU Engine is not running. Use starts it."
            className={look.stopped}
          >
            Not running
          </span>
        ) : (
          <span className={look.active}>Active</span>
        )
      )}

      {/* A14: a copy LU's refusal-removal tool made. */}
      {refusalsRemoved && (
        <span data-testid="model-card-refusals-removed" className={look.mark} title="LU removed the refusals of this copy. The original model is listed separately.">
          refusals removed
        </span>
      )}

      {/* Compact meta — size · params · quant, dot-separated, mono figures */}
      <span className={look.meta}>
        {model.size > 0 && <span>{formatBytes(model.size)}</span>}
        {model.type === 'text' && 'details' in model && model.details?.parameter_size && (
          <><span className="opacity-40">·</span><span>{model.details.parameter_size}</span></>
        )}
        {model.type === 'text' && 'details' in model && model.details?.quantization_level && (
          <><span className="opacity-40">·</span><span>{model.details.quantization_level}</span></>
        )}
        {/* The file's own ending when nothing set a format. The fixed fallback
            labelled an AnimateDiff .ckpt "safetensors" (3.0.4 Gegenprobe,
            02.10.2026). */}
        {(model.type === 'image' || model.type === 'video') && fileFormat(model) && (
          <><span className="opacity-40">·</span><span>{fileFormat(model)}</span></>
        )}
        {model.type === 'video' && createTabForArchitecture(model.architecture) && (
          <><span className="opacity-40">·</span><span data-testid="model-card-create-tab">in Create: {createTabForArchitecture(model.architecture)}</span></>
        )}
      </span>

      {/* Actions — always visible (LM-Studio: no hover-to-reveal) */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* The pick marks the row Active at once, while the engine is still
            loading the GGUF, so the button stays for as long as its own swap
            runs. Dropping it there would take the Loading state off screen at
            the exact moment it is the answer to "did that work". */}
        {onUse && (!isActive || useBusy || engineStopped) && (
          <button
            onClick={(e) => { e.stopPropagation(); if (!useBusy) onUse() }}
            disabled={useBusy}
            data-testid="model-card-use"
            className={look.use}
            title="Load this model on the LU Engine and use it for chat"
          >
            {useBusy && <Loader2 size={look.useSpinnerSize} className="animate-spin" />}
            {useBusy ? 'Loading…' : 'Use'}
          </button>
        )}
        {/* A model that could take images and has no image part installed:
            one click fetches it. Draws nothing for every other row. */}
        {model.type === 'text' && <AddImageInput model={model} label={`${displayModelName(model.name)} image input`} />}
        {actions.removeRefusals && (
          <button
            onClick={(e) => { e.stopPropagation(); actions.removeRefusals?.() }}
            data-testid="model-card-remove-refusals"
            className={look.info}
            title="Remove refusals: make a copy of this model that refuses fewer requests"
            aria-label={`Remove refusals from ${displayModelName(model.name)}`}
          >
            <ShieldOff size={ICON_SM} />
          </button>
        )}
        {model.type === 'text' && (
          <div onClick={(e) => e.stopPropagation()}>
            <BenchmarkButton modelName={model.name} />
          </div>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); actions.info() }}
          className={look.info}
          title={infoTitle ?? 'Details'}
        >
          <Info size={ICON_SM} />
        </button>
        {canDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); actions.remove() }}
            className={look.remove}
            title="Delete"
          >
            <Trash2 size={ICON_SM} />
          </button>
        )}
      </div>
    </div>

    {menu && (
      /* Das aria-label traegt denselben Namen wie Text und title daneben. Ein
         Screenreader las hier "Actions for openai::Phi-4-mini-instruct-Q4_K_M"
         vor, samt unserem Steckplatznamen, den kein Kunde gewaehlt hat. */
      <ContextMenu
        items={buildModelCardMenu(actions, { isActive, canDelete })}
        x={menu.x}
        y={menu.y}
        label={`Actions for ${displayModelName(model.name)}`}
        onClose={() => setMenu(null)}
      />
    )}
    </>
  )
}
