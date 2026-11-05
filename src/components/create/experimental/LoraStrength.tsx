import { useId, useState } from 'react'
import { Slider } from '../ui/Slider'
import {
  LORA_STRENGTH_MAX, LORA_STRENGTH_MIN, LORA_STRENGTH_STEP,
  loraSliderReach, parseLoraStrength, stepLoraStrength,
} from '../../../lib/lora-strength'

interface Props {
  /** The LoRA this strength belongs to, as its row names it (a file name or
   *  a catalogue name), for the field's accessible name. */
  name: string
  value: number
  onChange: (v: number) => void
}

const shown = (v: number) => v.toFixed(2)

/**
 * The strength of one LoRA in the stack: the slider for -2 to 2 with 0 marked
 * in the middle, and a number field for the exact value, which takes -20 to 20
 * (Discord 2026-10-02: slider LoRAs for Krea 2 are made
 * for about -10 to 10, negative included; Discord 2026-10-23: some for -10 to
 * 15). A typed value beyond 2 widens the slider to it (Discord 2026-11-01), and
 * the slider stays that wide while the control is open, so dragging back
 * towards 0 does not shrink the track under the thumb.
 *
 * The field is a text input on purpose. While someone types, "-" and "1," are
 * not numbers yet, and a number input hands those back as an empty string, so
 * the half-typed value could not be kept. What is typed is applied as soon as
 * it reads as a number; leaving the field shows the applied value again, so a
 * typo never stays on screen as if it counted.
 */
export function LoraStrength({ name, value, onChange }: Props) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [reach, setReach] = useState(() => loraSliderReach(value))
  if (loraSliderReach(value) > reach) setReach(loraSliderReach(value))
  const label = name.replace(/^.*[\\/]/, '').replace(/\.safetensors$/i, '')
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="t-control text-gray-400">Strength</label>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label={`Strength of ${label}`}
          title={`${LORA_STRENGTH_MIN} to ${LORA_STRENGTH_MAX}`}
          value={draft ?? shown(value)}
          onFocus={(e) => { setDraft(shown(value)); e.target.select() }}
          onChange={(e) => {
            setDraft(e.target.value)
            const typed = parseLoraStrength(e.target.value)
            if (typed !== null) onChange(typed)
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.currentTarget.blur(); return }
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            const next = stepLoraStrength(value, e.key === 'ArrowUp' ? 1 : -1)
            onChange(next)
            setDraft(shown(next))
          }}
          className="w-16 h-6 px-1.5 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.08] focus:border-white/20 outline-none text-right t-mono text-gray-200"
        />
      </div>
      <Slider
        min={-reach}
        max={reach}
        step={LORA_STRENGTH_STEP}
        origin={0}
        value={Math.max(-reach, Math.min(reach, value))}
        onChange={onChange}
      />
    </div>
  )
}
