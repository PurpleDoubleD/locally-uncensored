import { useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { compactThresholdFromPercent, stepCompactPercent } from '../../lib/settings-catalog'

/**
 * The "Compact at" field under Settings, General, Generation. Shown in
 * percent, stored as a fraction; 0 (fit the model) or 30 to 95.
 *
 * Jaeger B, B1: every keystroke used to be saved through the 0-or-30-95 rule,
 * so the first digit of "50" became 0 before the second could follow, and an
 * arrow step went 0 to 5, which the rule turned back into 0. The field now
 * keeps what is typed until it loses focus or Enter is pressed, the same way
 * the chat reply timeout does (ChatReplyTimeoutSettings.tsx), and a step
 * jumps the gap between 0 and 30 instead of landing in it.
 */
export function CompactThresholdInput() {
  const threshold = useSettingsStore((s) => s.settings.autoCompactThreshold)
  const disabled = useSettingsStore((s) => s.settings.autoCompact === false)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [draft, setDraft] = useState<string | null>(null)
  const stored = Math.round((threshold || 0) * 100)

  // Same rule as set_setting from the chat (lib/settings-catalog.ts).
  const save = (pct: number) => updateSettings({ autoCompactThreshold: compactThresholdFromPercent(pct) })
  const commit = () => {
    if (draft === null) return
    save(parseInt(draft, 10) || 0)
    setDraft(null)
  }
  const step = (dir: 1 | -1) => {
    const from = draft === null ? stored : compactThresholdFromPercent(parseInt(draft, 10) || 0) * 100
    save(stepCompactPercent(from, dir))
    setDraft(null)
  }

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    // The spin buttons change the value without typing: the browser sends a
    // plain input event, typing sends an InputEvent with an inputType.
    const native = e.nativeEvent as Partial<InputEvent>
    const typed = typeof native.inputType === 'string' && native.inputType !== ''
    const n = parseInt(e.target.value, 10)
    const shown = draft === null ? stored : parseInt(draft, 10)
    if (!typed && draft === null && Number.isFinite(n) && Math.abs(n - shown) === 5) {
      step(n > shown ? 1 : -1)
      return
    }
    setDraft(e.target.value)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      step(e.key === 'ArrowUp' ? 1 : -1)
    } else if (e.key === 'Enter') {
      commit()
    }
  }

  return (
    <input
      aria-label="Auto-compact at"
      type="number"
      value={draft ?? String(stored)}
      disabled={disabled}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={commit}
      min={0}
      max={95}
      step={5}
      placeholder="0"
      className="w-20 px-1.5 py-0.5 rounded bg-transparent border border-white/8 t-mono text-right text-gray-300 focus:outline-none focus:border-white/20 disabled:opacity-40"
    />
  )
}
