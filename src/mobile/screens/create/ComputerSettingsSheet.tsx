/**
 * K14 On your computer. Sheet "create-computer", opened from the composer of
 * "My computer" (ComputerSurface.tsx).
 *
 * The model list and the fields come from the computer (`capabilities`,
 * one simple JSON schema per kind): what to leave out, width, height, steps,
 * seed, how many. An empty number means "the computer decides". No price,
 * no time: the computer is the user's own.
 */
import { Monitor } from 'lucide-react'
import { COMPUTER_STRINGS as C, CREATE_STRINGS as T } from '../../strings/create'
import { useSheet } from '../../nav'
import { useCreateSource } from './parts/computer-source'
import { TOOL_ICON } from './parts/ui'
import { ListGroup, Notice, NumberField, Row, Segmented, Sheet, TextArea } from '../../ui'
import type { ComputerField, ComputerModel } from '../../remote/desktopCreate'
import { fitNumber, modelFor, settingFields, shownValue, sizeNote, useComputerForm } from './parts/computer-form'
import { useComputerRun } from './parts/computer-run'
import { useComputerTool } from './parts/computer-use'

function NumberRow({ f, disabled, model }: { f: ComputerField; disabled: boolean; model: ComputerModel | null }) {
  const values = useComputerForm((s) => s.values)
  const setValue = useComputerForm((s) => s.setValue)
  const title = C.fieldTitle(f.key, f.title)
  if (f.key === 'count' && f.maximum !== undefined && f.maximum > 1 && f.maximum <= 4) {
    const v = String(shownValue(f, values) ?? 1)
    const options = Array.from({ length: f.maximum }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
    return (
      <div className="m-k-sec" data-testid="m-create-computer-field-count">
        <div className="m-label">{C.count}</div>
        <Segmented label={C.count} options={options} value={v} onChange={(x) => setValue('count', Number(x))} testid="m-create-computer-count" />
      </div>
    )
  }
  if (f.key === 'count') return null
  // A fixed list (upscale `factor`) has its choice on the stage.
  if (f.enumNumbers) return null
  const min = f.minimum ?? 0
  const max = f.maximum ?? Number.MAX_SAFE_INTEGER
  return (
    <div className="m-k-sec" data-testid={`m-create-computer-field-${f.key}`}>
      <NumberField
        label={title}
        showLabel
        hint={values[f.key] === undefined ? (f.key === 'seed' ? C.seedRandom : C.defaultValue) : undefined}
        integer
        min={min}
        max={max}
        step={f.multipleOf ?? 1}
        value={shownValue(f, values, model) ?? min}
        onChange={(n: number) => setValue(f.key, fitNumber(f, n))}
        disabled={disabled}
        testid={`m-create-computer-${f.key}`}
      />
    </div>
  )
}

export default function ComputerSettingsSheet() {
  const { caps, kind, info, row, tool } = useComputerTool()
  const setTool = useCreateSource((st) => st.setTool)
  const setSource = useCreateSource((st) => st.setSource)
  const { close } = useSheet()
  const form = useComputerForm()
  const run = useComputerRun((s) => s.view)
  const busy = run === 'sending' || run === 'running' || run === 'loading'
  const model = modelFor(info, form.models[kind])
  const fields = settingFields(info)
  const note = sizeNote(info, form, kind)
  return (
    <Sheet title={C.settingsTitle} testid="m-create-computer-sheet">
      {/* Prompt v2 (14.11.2026): the tool row above the field and the source chip live here now. */}
      <ListGroup title={T.run.what} role="radiogroup" testid="m-create-computer-tools">
        {row.map((t) => (
          <Row
            key={t.id}
            icon={TOOL_ICON[t.id]}
            title={t.available ? T.tool[t.id].name : `${T.tool[t.id].name}. ${C.unavailableMark}`}
            radio={{ checked: t.id === tool, onSelect: () => setTool(t.id) }}
            disabled={busy}
            testid={`m-create-computer-tool-${t.id}`}
          />
        ))}
      </ListGroup>
      <ListGroup>
        <Row
          title={T.run.runsOn}
          icon={Monitor}
          value={C.computer}
          subtitle={C.useCloud}
          disabled={busy}
          onPress={() => {
            close()
            setSource('cloud')
          }}
          testid="m-create-source-cloud"
        />
      </ListGroup>
      {caps.state !== 'ok' ? (
        <div className="m-k-sec">
          <Notice testid="m-create-computer-sheet-wait">{caps.state === 'error' ? caps.message : C.loading}</Notice>
        </div>
      ) : null}
      {info && info.models.length > 0 ? (
        <ListGroup title={C.model} role="radiogroup" testid="m-create-computer-models">
          {info.models.map((m) => (
            <Row
              key={m.id}
              icon={Monitor}
              title={m.name}
              radio={{ checked: model?.id === m.id, onSelect: () => form.setModel(kind, m.id) }}
              disabled={busy}
              testid="m-create-computer-model-row"
            />
          ))}
        </ListGroup>
      ) : null}
      {fields.some((f) => f.key === 'negative') ? (
        <div className="m-k-sec">
          <TextArea label={C.negative} value={form.negative} placeholder={C.negativePlaceholder} onChange={form.setNegative} rows={2} disabled={busy} testid="m-create-computer-negative" />
        </div>
      ) : null}
      {fields.filter((f) => f.type === 'integer').map((f) => (
        <NumberRow key={f.key} f={f} disabled={busy} model={model} />
      ))}
      {note ? (
        <div className="m-k-sec">
          <Notice variant="warn" testid="m-create-computer-size-note">
            {note}
          </Notice>
        </div>
      ) : null}
    </Sheet>
  )
}
