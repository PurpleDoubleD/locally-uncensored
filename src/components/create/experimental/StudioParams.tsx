// Die Regler des gewaehlten Studio-Modells, aus dessen eigenem Schema.
//
// Ersetzt in AdvancedDrawer bei gesetztem `studioModel` die lokale Kombination
// aus WorkflowFinder + ParamGroups vollstaendig (Portplan Abschnitt 3b/3c):
// ein Studio-Modell hat keinen Sampler, keinen Scheduler, kein VAE und keine
// LoRA-Liste aus ComfyUI, also stehen hier ausschliesslich die Felder, die der
// Anbieter fuer dieses eine Modell wirklich liest.
import { SlidersHorizontal } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { SchemaControl, isCompactField, studioFieldsInOrder } from './SchemaControl'
import { modelHint, modelLabel } from '../../../lib/render/preset-models'
import { studioShownValue } from '../../../lib/render/create-studio'
import { STUDIO_MODELS } from '../../../lib/render/studio-contract'
import { musicText } from '../../../lib/render/music-ui'
import { swapPanelFields } from '../../../lib/render/swap'
import { scenePanelFields } from '../../../lib/render/scene'

export function StudioParams({ model }: { model: string }) {
  const options = useCreateStore((s) => s.cloudStudioOptions)
  const setOptions = useCreateStore((s) => s.setCloudStudioOptions)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  // Swap Character shows a role per person and the resolution in its own
  // panel, and fixes the mode (lib/render/swap.ts): none of them twice here.
  const intent = useCreateStore((s) => s.intent())
  // Scene to Video sets length, size and the keyframe list from the clip.
  const inPanel = [...swapPanelFields(intent), ...(intent === 'scene' ? scenePanelFields(model) : [])]
  const fields = studioFieldsInOrder(model).filter(([key]) => !inPanel.includes(key))
  const hint = modelHint(model)
  // Mureka Song calls its style field "prompt" while the prompt field carries
  // the lyrics. The control is named for what it does.
  const styleOption = STUDIO_MODELS[model]?.kind === 'audio' ? musicText(model).second : null
  return (
    <div className="px-1 py-3">
      {/* Eine Ueberschrift, damit die Klappe sagt, wessen Einstellungen das
          sind: sie zeigt je nach Modell voellig andere Felder. */}
      <div className="mb-2.5 flex items-center gap-1.5 border-b border-white/[0.06] pb-2">
        <SlidersHorizontal size={12} className="shrink-0 text-gray-500" />
        <span className="t-control truncate text-gray-300">{modelLabel(model)}</span>
      </div>
      {hint && <p className="t-body mb-2.5 text-gray-500">{hint}</p>}
      {/* Zwei Spalten: eine Zahl mit einer Stelle und eine Liste mit vier
          Werten brauchen keine volle Breite. Was Text traegt, bekommt sie. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        {fields.map(([key, schema]) => (
          <div key={key} className={isCompactField(schema) ? undefined : 'col-span-2'}>
            <SchemaControl
              name={key}
              title={styleOption?.option === key ? (styleOption.is === 'style' ? 'Style' : 'Lyrics') : undefined}
              schema={schema}
              value={studioShownValue(model, options, key)}
              disabled={isGenerating}
              onChange={(v) => setOptions({ ...options, [key]: v })}
            />
          </div>
        ))}
      </div>
      {!fields.length && <p className="t-body text-gray-500">This model has no extra settings.</p>}
    </div>
  )
}
