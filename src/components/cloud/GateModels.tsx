// The three model dropdowns of the gate pop-up (3.0.7): Chat, Code, Create.
//
// Only somebody without a usable account sees them (CloudSalesPanel). They
// show what the switch leads to, in the app's real model picker: the trigger
// is the composer's `lu-control`, the menu is the Cloud mode picker itself
// (CloudModelPicker), so a row here looks exactly like the row it will be.
// A row is not usable yet: its click opens a short window with the two ways
// in, each one button to the checkout in the browser (lib/cloud-gate).
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ExternalLink, ArrowLeft } from 'lucide-react'
import { CloudModelPicker, CLOUD_PICKER_MAX_HEIGHT, CLOUD_PICKER_WIDTH } from '../models/CloudModelPicker'
import { usePopoverPlatz } from '../../hooks/usePopoverPlatz'
import { useGraphicsMemoryGb } from '../../hooks/useGraphicsMemory'
import { useCloudGateStore, refreshGateCatalog } from '../../stores/cloudGateStore'
import { useUIStore } from '../../stores/uiStore'
import { reportCloudGate } from '../../api/funnel'
import { openExternal, isMacOS } from '../../api/backend'
import { CLOUD_BASE } from '../../api/cloud/config'
import { prefixModelName } from '../../api/providers'
import { getTotalRamGb } from '../../lib/hardware'
import { chatModelBudgetGb } from '../../lib/shared-memory-wording'
import {
  GATE_SEED, GATE_CATEGORY_LABEL, GATE_CREATE_KINDS, GATE_CREATE_KIND_LABEL,
  gateCheckoutUrl, gateOfferLine, tooBigForThisMachine, tooBigLine,
  type GateCatalog, type GateCategory, type GateCreateKind, type GateModel, type GateWay,
} from '../../lib/cloud-gate'
import type { AIModel } from '../../types/models'

const DOT: Record<GateCategory, string> = { chat: 'bg-blue-400', code: 'bg-emerald-400', create: 'bg-purple-400' }

/** A catalogue entry as the picker reads a row. Never in the model store:
 *  nothing outside this pop-up can pick it. */
function asPickerModel(m: GateModel, quietNote?: string): AIModel {
  return {
    name: m.id, model: m.id, size: 0, type: 'text', provider: 'lu-cloud', providerName: 'LU Cloud',
    displayName: m.label, ...(quietNote ? { quietNote } : {}),
    // The measured mark, the one Create shows on these models.
    ...(m.adult ? { unfiltered: 'full' as const } : {}),
  }
}

/** The memory a local model may use on this machine, as the Model Manager
 *  reads it (the card on a PC, the model's share of the pool on a Mac). */
function useLocalModelBudgetGb(): number | null {
  const card = useGraphicsMemoryGb()
  const [ram, setRam] = useState<number | null>(null)
  useEffect(() => {
    if (!isMacOS()) return
    let alive = true
    getTotalRamGb().then((r) => { if (alive && r > 0) setRam(r) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return chatModelBudgetGb(isMacOS(), card, ram)
}

function GateDropdown({ category, models, onPick }: {
  category: GateCategory
  models: GateModel[]
  onPick: (m: GateModel) => void
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<GateCreateKind>('image')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLElement | null>(null)
  const lage = usePopoverPlatz(menuRef, open, {
    anker: triggerRef, fest: 'links', abstand: 6, luft: 8, deckel: CLOUD_PICKER_MAX_HEIGHT, rolle: listRef,
  })
  const budget = useLocalModelBudgetGb()
  const mac = isMacOS()

  const shown = category === 'create' ? models.filter((m) => m.kind === kind) : models
  const rows = useMemo(
    () => shown.map((m) => asPickerModel(m, category !== 'create' && tooBigForThisMachine(m.id, budget) ? tooBigLine(mac) : undefined)),
    [shown, category, budget, mac],
  )
  const kinds = GATE_CREATE_KINDS.filter((k) => models.some((m) => m.kind === k))

  const close = () => {
    setOpen(false)
    back.current?.focus?.()
  }

  // A press outside the menu and its trigger puts it away.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  return (
    <div className="min-w-0 flex flex-col items-center gap-1">
      <span className="t-label text-gray-500">{GATE_CATEGORY_LABEL[category]}</span>
      <button
        ref={triggerRef}
        type="button"
        className="lu-control max-w-full"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`gate-dropdown-${category}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${DOT[category]}`} />
        <span className="min-w-0 max-w-[140px] truncate leading-none">
          {models.length} {models.length === 1 ? 'model' : 'models'}
        </span>
        <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          data-testid={`gate-menu-${category}`}
          data-picker="cloud"
          className="lu-elevated lu-picker flex flex-col overflow-hidden"
          // The placement says max-content; the picker has its fixed width.
          style={{ ...lage.style, width: CLOUD_PICKER_WIDTH, zIndex: 60 }}
          onKeyDown={(e) => {
            // The picker hands up an Escape it does not need itself. Stopped
            // here, the gate behind the menu stays open.
            if (e.key === 'Escape') { e.stopPropagation(); close() }
          }}
        >
          {category === 'create' && kinds.length > 0 && (
            <div className="lu-picker-chips" role="group" aria-label="Kind">
              {kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="lu-picker-chip"
                  aria-pressed={kind === k}
                  data-chip={k}
                  onClick={() => setKind(k)}
                >
                  {GATE_CREATE_KIND_LABEL[k]} <i>{models.filter((m) => m.kind === k).length}</i>
                </button>
              ))}
            </div>
          )}
          <CloudModelPicker
            key={kind}
            models={rows}
            activeModel={null}
            loading={false}
            notes={[]}
            hiddenForCode={0}
            empty={<p className="lu-picker-empty">No models listed right now.</p>}
            listRef={listRef}
            onPick={(row) => {
              const m = shown.find((x) => x.id === row.name)
              if (!m) return
              setOpen(false)
              onPick(m)
            }}
            onTookFocus={(from) => { back.current = from }}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}

const wayBtn =
  'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg t-control bg-lu-cloud text-white hover:opacity-90 transition-opacity'

/** The short window behind a row: the two ways in, each one button. */
function GateBuyWindow({ model, category, offers, onBack }: {
  model: GateModel
  category: GateCategory
  offers: GateCatalog['offers']
  onBack: () => void
}) {
  const budget = useLocalModelBudgetGb()
  const big = category !== 'create' && tooBigForThisMachine(model.id, budget)
  const go = (way: GateWay) => {
    reportCloudGate(way === 'sub' ? 'cloud_gate_pick_sub' : 'cloud_gate_pick_credits')
    void openExternal(gateCheckoutUrl(CLOUD_BASE, way, model.id, category, useUIStore.getState().cloudGateFrom))
  }
  const ways: { way: GateWay; title: string; button: string }[] = [
    { way: 'sub', title: 'Subscription', button: 'Subscribe' },
    { way: 'credits', title: 'Credits', button: 'Buy credits' },
  ]
  return (
    <div role="dialog" aria-label={model.label} data-testid="gate-buy-window" className="space-y-3 max-w-xs mx-auto">
      <div className="text-center space-y-0.5">
        <p className="t-control font-semibold text-gray-900 dark:text-white truncate" title={model.id}>{model.label}</p>
        <p className="t-micro text-gray-500 dark:text-gray-400">
          {big ? tooBigLine(isMacOS()) : 'Runs in LU Cloud'}. Pick a way in:
        </p>
      </div>
      {ways.map(({ way, title, button }) => {
        const line = gateOfferLine(way, offers)
        return (
          <div key={way} data-way={way} className="rounded-lg border border-gray-200 dark:border-white/10 p-2.5 space-y-2">
            <div>
              <p className="t-control font-semibold text-gray-800 dark:text-gray-200">{title}</p>
              {line && <p className="t-micro text-gray-500 dark:text-gray-400" data-testid={`gate-offer-${way}`}>{line}</p>}
            </div>
            <button type="button" className={wayBtn} onClick={() => go(way)} data-testid={`gate-checkout-${way}`}>
              <ExternalLink size={12} /> {button}
            </button>
          </div>
        )
      })}
      <p className="t-micro text-center text-gray-400 dark:text-gray-500">
        Opens in your browser. Once you are signed in here, LU opens on this model.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="w-full flex items-center justify-center gap-1 t-micro text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
      >
        <ArrowLeft size={11} /> Back
      </button>
    </div>
  )
}

/** The three dropdowns, or the buy window of the row that was clicked. */
export function GateModels() {
  const live = useCloudGateStore((s) => s.catalog)
  const setPick = useCloudGateStore((s) => s.setPick)
  const setPendingCloudModel = useUIStore((s) => s.setPendingCloudModel)
  const catalog = live ?? GATE_SEED
  const [buy, setBuy] = useState<{ model: GateModel; category: GateCategory } | null>(null)

  useEffect(() => { void refreshGateCatalog() }, [])

  const pick = (category: GateCategory) => (model: GateModel) => {
    reportCloudGate('cloud_gate_model_click')
    // Kept until the account can use it, through a checkout, a restart and
    // a sign in (CloudGateModal lands on it).
    setPick({ model: model.id, category, ...(model.kind ? { kind: model.kind } : {}), at: Date.now() })
    // A sign in from this same gate flips right away; the mode rule reads it.
    if (category !== 'create') setPendingCloudModel(prefixModelName('lu-cloud', model.id))
    setBuy({ model, category })
  }

  if (buy) {
    return <GateBuyWindow model={buy.model} category={buy.category} offers={catalog.offers} onBack={() => setBuy(null)} />
  }
  return (
    <div className="grid grid-cols-3 gap-2 max-w-xs mx-auto" data-testid="gate-models">
      {(['chat', 'code', 'create'] as const).map((c) => (
        <GateDropdown key={c} category={c} models={catalog.categories[c]} onPick={pick(c)} />
      ))}
    </div>
  )
}
