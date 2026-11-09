// 3.0.8 (A2, .molot): one card for the chat, another for pictures and video.
// Shown only with two or more cards; with one card nothing changes and this
// section is not there. The forwarding lives in Rust (commands/gpu_roles.rs),
// this is the pick and a readout of what each service will be started with.

import { useEffect, useMemo, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { backendCall, isTauri } from '../../api/backend'
import { normalizeGpuRoles, gpuRolesSeparate, sameCard, comfySplitOf, comfyCards } from '../../lib/gpu-roles'
import type { ComfySplit, GpuRef } from '../../types/settings'
import { Hinweis } from '../ui/Hinweis'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { formatBytes } from '../../lib/formatters'

export interface RoleCard {
  index: number
  vendor: string
  name: string
  memory_mib: number | null
}

interface RolePlan {
  service: string
  env: string[]
  args: string[]
  note?: string | null
}

const PICKABLE = new Set(['nvidia', 'amd', 'intel'])

/** The cards a role can be pinned to: the vendors LU can forward a pick to. */
export function roleCards(gpus: RoleCard[]): RoleCard[] {
  return gpus.filter((g) => PICKABLE.has(g.vendor))
}

/** The cards the split can use: NVIDIA only (gpu_roles.rs, ComfySplit). */
export function splitCards(gpus: RoleCard[]): RoleCard[] {
  return gpus.filter((g) => g.vendor === 'nvidia')
}

function refOf(g: RoleCard): GpuRef {
  return { vendor: g.vendor as GpuRef['vendor'], index: g.index, name: g.name }
}

/**
 * The split a fresh tick starts with: the model on the ComfyUI card when
 * one is picked, else on the card with the most memory; the text encoders and
 * the VAE on the biggest of the others.
 */
export function defaultSplit(cards: RoleCard[], comfy: GpuRef | null): ComfySplit | null {
  const nv = splitCards(cards)
  if (nv.length < 2) return null
  const bySize = [...nv].sort((a, b) => (b.memory_mib ?? 0) - (a.memory_mib ?? 0) || a.index - b.index)
  const model = (comfy && nv.find((g) => sameCard(refOf(g), comfy))) || bySize[0]
  const helper = bySize.find((g) => g.index !== model.index)!
  return { model: refOf(model), helper: refOf(helper) }
}

function keyOf(r: GpuRef | null): string {
  return r ? `${r.vendor}:${r.index}` : ''
}

function label(g: RoleCard): string {
  const mem = g.memory_mib ? ` · ${formatBytes(g.memory_mib * 1024 * 1024)}` : ''
  return `#${g.index} ${g.name}${mem}`
}

export function GpuRolesPicker({ gpus }: { gpus: RoleCard[] }) {
  const { settings, updateSettings } = useSettingsStore()
  const roles = useMemo(() => normalizeGpuRoles(settings.gpuRoles), [settings.gpuRoles])
  const cards = useMemo(() => roleCards(gpus), [gpus])
  const [plan, setPlan] = useState<RolePlan[] | null>(null)
  const [changed, setChanged] = useState(false)

  // Rust holds the pick in memory; every change goes down at once, so the
  // next start of ComfyUI, Ollama or the LU Engine reads it.
  useEffect(() => {
    backendCall('set_gpu_roles', { roles }).catch(() => {})
  }, [roles])

  // The readout: what each service would get. Asked again after a change.
  useEffect(() => {
    if (!isTauri()) return
    let live = true
    backendCall<RolePlan[]>('describe_gpu_roles')
      .then((p) => { if (live) setPlan(Array.isArray(p) ? p : null) })
      .catch(() => { if (live) setPlan(null) })
    return () => { live = false }
  }, [roles])

  if (cards.length < 2) return null

  const split = comfySplitOf(roles)
  const nvCards = splitCards(cards)

  const pick = (role: 'chat' | 'comfy', key: string) => {
    const card = cards.find((g) => `${g.vendor}:${g.index}` === key)
    const ref: GpuRef | null = card ? refOf(card) : null
    updateSettings({ gpuRoles: { ...roles, [role]: ref } })
    setChanged(true)
  }

  const setSplit = (next: ComfySplit | null) => {
    const { comfySplit: _old, ...rest } = roles
    void _old
    updateSettings({ gpuRoles: next ? { ...rest, comfySplit: next } : rest })
    setChanged(true)
  }

  const pickSplit = (part: 'model' | 'helper', key: string) => {
    if (!split) return
    const card = nvCards.find((g) => `${g.vendor}:${g.index}` === key)
    if (!card) return
    const other = part === 'model' ? 'helper' : 'model'
    const next: ComfySplit = { ...split, [part]: refOf(card) }
    // Picking the other part's card swaps the two, so they never coincide.
    if (sameCard(next[part], next[other])) next[other] = split[part]
    setSplit(next)
  }

  const selectClass = 'mt-0.5 w-full rounded border border-gray-300 dark:border-white/10 bg-white dark:bg-white/[0.03] px-1.5 py-1 t-micro text-gray-800 dark:text-gray-200 disabled:opacity-50'

  const select = (role: 'chat' | 'comfy', title: string, help: string, disabled = false) => (
    <label className="block">
      <span className="t-micro text-gray-700 dark:text-gray-300">{title}</span>
      <select
        value={keyOf(roles[role])}
        onChange={(e) => pick(role, e.target.value)}
        aria-label={title}
        disabled={disabled}
        className={selectClass}
      >
        <option value="">Same as above</option>
        {cards.map((g) => (
          <option key={`${g.vendor}:${g.index}`} value={`${g.vendor}:${g.index}`}>{label(g)}</option>
        ))}
      </select>
      <span className="block t-micro text-gray-500 mt-0.5 leading-relaxed">{help}</span>
    </label>
  )

  const shared = !!roles.chat && comfyCards(roles).some((c) => sameCard(roles.chat, c))

  return (
    <div className="pt-2 border-t border-white/[0.06] space-y-2" data-testid="gpu-roles">
      <div>
        <div className="t-micro text-gray-700 dark:text-gray-300 font-medium">Card per task</div>
        <div className="t-micro text-gray-500 mt-0.5 leading-relaxed">
          Chat on one card, pictures and video on the other, so the chat stays fast while a video renders.
        </div>
      </div>
      {select('chat', 'Chat (LU Engine, Ollama)', 'The chat model loads onto this card only.')}
      {select(
        'comfy',
        'Pictures and video (ComfyUI)',
        split ? 'ComfyUI uses both cards below, so this pick waits until the split is off.' : 'ComfyUI sees this card only.',
        !!split,
      )}
      {nvCards.length >= 2 && (
        <div className="space-y-1.5" data-testid="comfy-split">
          <label className="flex items-start gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!split}
              onChange={(e) => setSplit(e.target.checked ? defaultSplit(nvCards, roles.comfy) : null)}
              aria-label="One big model across two cards"
              className="mt-0.5"
            />
            <span>
              <span className="block t-micro text-gray-700 dark:text-gray-300">One big model across two cards</span>
              <span className="block t-micro text-gray-500 leading-relaxed">
                For a picture or video model that does not fit on one card. The model keeps the first card to itself, the text encoder and the VAE load onto the second, instead of spilling into system memory.
              </span>
            </span>
          </label>
          {split && (
            <div className="pl-5 space-y-1.5">
              {(['model', 'helper'] as const).map((part) => {
                const title = part === 'model' ? 'Model on' : 'Text encoder and VAE on'
                return (
                  <label key={part} className="block">
                    <span className="t-micro text-gray-700 dark:text-gray-300">{title}</span>
                    <select
                      value={keyOf(split[part])}
                      onChange={(e) => pickSplit(part, e.target.value)}
                      aria-label={title}
                      className={selectClass}
                    >
                      {nvCards.map((g) => (
                        <option key={`${g.vendor}:${g.index}`} value={`${g.vendor}:${g.index}`}>{label(g)}</option>
                      ))}
                    </select>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}
      {gpuRolesSeparate(roles) && (
        <Hinweis>
          Two cards: LU no longer takes the chat model off its card to make room for a picture or a video.
        </Hinweis>
      )}
      {shared && (
        <Hinweis>
          Both on the same card: the chat model still has to make room while a video renders.
        </Hinweis>
      )}
      {changed && (
        <p className={`t-micro leading-relaxed ${HINWEIS_TEXT.ruhig}`} data-testid="gpu-roles-restart-hint">
          A running ComfyUI and a loaded chat model keep their card. Restart ComfyUI and load the chat model again to apply the change.
        </p>
      )}
      {plan && plan.length > 0 && (
        <details className="t-micro text-gray-500">
          <summary className="cursor-pointer select-none">What each service is started with</summary>
          <ul className="mt-1 space-y-1" data-testid="gpu-roles-plan">
            {plan.map((p) => (
              <li key={p.service}>
                <span className="text-gray-400">{p.service}:</span>{' '}
                <span className="font-mono">{[...p.env, ...p.args].join(' ') || 'every card (no pick)'}</span>
                {p.note && <span className="block">{p.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
