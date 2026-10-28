import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { GlowButton } from '../ui/GlowButton'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SamplerValues } from '../../types/settings'
import { clampSampling, TEMPERATURE_MAX, TEMPERATURE_HELP, TEMPERATURE_HELP_LABEL } from '../../lib/sampling'
import { HelpMark } from '../ui/HelpMark'
import { LongTextField } from '../ui/LongTextField'
import { CustomParamsEditor, CUSTOM_PARAMS_LABEL } from '../chat/CustomParamsEditor'
import { cleanCustomParams, type CustomParam } from '../../lib/custom-params'
import { HighTemperatureWarning } from '../chat/HighTemperatureWarning'
import { DEFAULT_NOTE_DEPTH, MAX_NOTE_DEPTH, clampNoteDepth } from '../../lib/persona-note'

/**
 * GH #175: the sampling values a persona brings along. An empty field is not
 * set: the chat then follows the Settings page for it, as before. Each value
 * reaches only a backend that reads it (api/providers/sampler-fields.ts), and
 * the Sampling popup in the chat says which ones do for the current model.
 */
export const PERSONA_SAMPLING_FIELDS: { key: keyof SamplerValues; label: string; step: number; min: number; max: number }[] = [
  { key: 'temperature', label: 'Temperature', step: 0.05, min: 0, max: TEMPERATURE_MAX },
  { key: 'topP', label: 'Top P', step: 0.01, min: 0, max: 1 },
  { key: 'topK', label: 'Top K', step: 1, min: 0, max: 1000 },
  { key: 'minP', label: 'Min P', step: 0.01, min: 0, max: 1 },
  { key: 'maxTokens', label: 'Max tokens', step: 128, min: 0, max: 1_000_000 },
  { key: 'repeatPenalty', label: 'Repeat penalty', step: 0.01, min: 0, max: 2 },
  { key: 'presencePenalty', label: 'Presence penalty', step: 0.05, min: -2, max: 2 },
  { key: 'frequencyPenalty', label: 'Frequency penalty', step: 0.05, min: -2, max: 2 },
  { key: 'dryMultiplier', label: 'DRY multiplier', step: 0.05, min: 0, max: 5 },
]

type SamplingDraft = Partial<Record<keyof SamplerValues, string>>

function draftOf(values?: SamplerValues): SamplingDraft {
  const out: SamplingDraft = {}
  for (const f of PERSONA_SAMPLING_FIELDS) {
    const v = values?.[f.key]
    if (v !== undefined) out[f.key] = String(v)
  }
  return out
}

/** The typed fields as values: empty boxes are left out, the rest clamped. */
export function samplingFromDraft(draft: SamplingDraft): SamplerValues | undefined {
  const raw: SamplerValues = {}
  for (const f of PERSONA_SAMPLING_FIELDS) {
    const text = draft[f.key]?.trim()
    if (!text) continue
    const n = Number(text)
    if (Number.isFinite(n)) raw[f.key] = f.key === 'topK' || f.key === 'maxTokens' ? Math.trunc(n) : n
  }
  const clamped = clampSampling(raw)
  return Object.keys(clamped).length > 0 ? clamped : undefined
}

/** GH #198: the rows to keep on the persona: every row with a name, as
 *  typed. Undefined when none, so the persona carries no empty field. */
export function customParamsFromDraft(rows: CustomParam[]): CustomParam[] | undefined {
  const kept = cleanCustomParams(rows).filter((r) => r.key.trim() !== '')
  return kept.length > 0 ? kept : undefined
}

/** GH #181: the typed reminder as persona fields. Whitespace only is none. */
export function noteFromDraft(text: string, depth: string): { note?: string; noteDepth?: number } {
  const note = text.trim()
  if (!note) return { note: undefined, noteDepth: undefined }
  return { note, noteDepth: clampNoteDepth(depth.trim() === '' ? undefined : Number(depth)) }
}

interface SystemPromptEditorProps {
  /** When set, the editor updates this persona in place instead of adding a
   *  new one (GitHub #55 — edit custom personas). The parent remounts the
   *  editor with a `key` so the seeded fields below refresh per persona. */
  editingId?: string | null
  initialName?: string
  initialPrompt?: string
  /** GH #175: the persona's sampling values, when editing one. */
  initialSampling?: SamplerValues
  /** GH #181: the persona's reminder and its depth, when editing one. */
  initialNote?: string
  initialNoteDepth?: number
  /** GH #198: the persona's custom sampling rows, when editing one. */
  initialCustomParams?: CustomParam[]
  /** Called after a successful save/update or a cancel, so the parent can
   *  close the editor. */
  onDone?: () => void
}

export function SystemPromptEditor({
  editingId,
  initialName = '',
  initialPrompt = '',
  initialSampling,
  initialNote = '',
  initialNoteDepth,
  initialCustomParams,
  onDone,
}: SystemPromptEditorProps) {
  const { addPersona, updatePersona } = useSettingsStore()
  const [name, setName] = useState(initialName)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [sampling, setSampling] = useState<SamplingDraft>(() => draftOf(initialSampling))
  const [note, setNote] = useState(initialNote)
  const [tempHelp, setTempHelp] = useState(false)
  const [noteDepth, setNoteDepth] = useState(String(initialNoteDepth ?? DEFAULT_NOTE_DEPTH))
  const [customParams, setCustomParams] = useState<CustomParam[]>(() => initialCustomParams ?? [])
  const isEditing = !!editingId

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return
    // GH #181: an empty reminder is no reminder, and then no depth either.
    const reminder = noteFromDraft(note, noteDepth)
    const custom = customParamsFromDraft(customParams)
    if (isEditing) {
      // Only the user-editable fields — keep id/icon/isBuiltIn untouched.
      updatePersona(editingId!, { name: name.trim(), systemPrompt: prompt.trim(), sampling: samplingFromDraft(sampling), note: reminder.note, noteDepth: reminder.noteDepth, customParams: custom })
    } else {
      addPersona({
        id: uuid(),
        name: name.trim(),
        icon: 'User',
        systemPrompt: prompt.trim(),
        isBuiltIn: false,
        ...(samplingFromDraft(sampling) ? { sampling: samplingFromDraft(sampling) } : {}),
        ...(reminder.note ? reminder : {}),
        ...(custom ? { customParams: custom } : {}),
      })
      setName('')
      setPrompt('')
      setSampling({})
      setNote('')
      setNoteDepth(String(DEFAULT_NOTE_DEPTH))
      setCustomParams([])
    }
    onDone?.()
  }

  return (
    <div className="space-y-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Persona name..."
        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm"
      />
      {/* GH #197: drags taller, remembers it, opens large with search. */}
      <LongTextField
        value={prompt}
        onChange={setPrompt}
        storageKey="persona-prompt"
        label="System prompt"
        placeholder="System prompt..."
        rows={4}
        testId="persona-prompt"
        className="block w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm"
      />
      <fieldset data-testid="persona-sampling" className="rounded-lg border border-white/10 px-3 pb-2 pt-1">
        <legend className="px-1 text-[0.6rem] text-gray-400">Sampling for this persona</legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5">
          {PERSONA_SAMPLING_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-0.5 text-[0.6rem] text-gray-400">
              <span className="flex items-center gap-1">
                {f.label}
                {f.key === 'temperature' && (
                  <HelpMark
                    text={TEMPERATURE_HELP}
                    label={TEMPERATURE_HELP_LABEL}
                    open={tempHelp}
                    onToggle={() => setTempHelp((v) => !v)}
                    testId="temperature-help"
                  />
                )}
              </span>
              <input
                type="number"
                inputMode="decimal"
                aria-label={f.label}
                step={f.step}
                min={f.min}
                max={f.max}
                placeholder="chat default"
                value={sampling[f.key] ?? ''}
                onChange={(e) => setSampling((d) => ({ ...d, [f.key]: e.target.value }))}
                className="w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:outline-none focus:border-white/20 text-xs"
              />
            </label>
          ))}
        </div>
        {tempHelp && (
          <p className="mt-1.5 t-micro leading-relaxed text-gray-500" data-testid="temperature-help-text">{TEMPERATURE_HELP}</p>
        )}
        <div className="mt-1.5">
          <HighTemperatureWarning
            temperature={sampling.temperature === undefined || sampling.temperature === '' ? undefined : Number(sampling.temperature)}
            onReset={() => setSampling((d) => ({ ...d, temperature: '' }))}
          />
        </div>
        <p className="mt-1.5 text-[0.55rem] text-gray-500">
          Empty fields follow the chat. A value moved in the chat's Sampling popup still wins. Each value only reaches a backend that reads it.
        </p>
      </fieldset>
      <fieldset data-testid="persona-custom-params" className="rounded-lg border border-white/10 px-3 pb-2 pt-1 text-xs text-gray-200">
        <legend className="px-1 t-micro text-gray-400">{CUSTOM_PARAMS_LABEL}</legend>
        <CustomParamsEditor rows={customParams} onChange={setCustomParams} testId="persona-custom-param-list" />
        <p className="mt-1 t-micro text-gray-500">
          For samplers without a field above, e.g. dry_base, xtc_threshold, logit_bias. A chat's own row with the same name wins.
        </p>
      </fieldset>
      <fieldset data-testid="persona-note" className="rounded-lg border border-white/10 px-3 pb-2 pt-1">
        <legend className="px-1 t-micro text-gray-400">Reminder</legend>
        <LongTextField
          value={note}
          onChange={setNote}
          storageKey="persona-reminder"
          label="Reminder"
          placeholder="Short rules to keep in mind, e.g. speech style or status block format..."
          rows={2}
          testId="persona-reminder"
          className="block w-full px-2 py-1 rounded bg-white/5 border border-white/10 text-white placeholder-gray-600 focus:outline-none focus:border-white/20 text-xs"
        />
        <label className="mt-1.5 flex items-center gap-2 t-micro text-gray-400">
          <span>Messages from the end</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Reminder depth"
            step={1}
            min={0}
            max={MAX_NOTE_DEPTH}
            value={noteDepth}
            onChange={(e) => setNoteDepth(e.target.value)}
            className="w-16 px-2 py-1 rounded bg-white/5 border border-white/10 text-white focus:outline-none focus:border-white/20 text-xs"
          />
        </label>
        <p className="mt-1.5 t-micro text-gray-500">
          Sent with every reply this persona writes, also in group chats, close to the end of the chat. 0 is the latest message. It is not saved in the chat.
        </p>
      </fieldset>
      <div className="flex gap-2">
        <GlowButton onClick={handleSave} disabled={!name.trim() || !prompt.trim()} className="flex-1">
          {isEditing ? 'Update Persona' : 'Save Persona'}
        </GlowButton>
        {onDone && (
          <button
            onClick={onDone}
            className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 border border-white/10 hover:border-white/20 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
