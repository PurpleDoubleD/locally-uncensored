// The two ways into LU Cloud side by side, the same size and the same weight
// (funnel 3.1.0, Nr. 4): a subscription, and a credit pack that is no
// subscription. Until 3.1.0 the gate's one big button said "19 EUR / month"
// and the Create sheet sold only the subscription; the pack sat three clicks
// deep. 539 of 718 pack buyers never took a subscription, so the pack is a
// way in of its own, not a footnote.
//
// Both buttons go to the checkout start on lu-labs.ai (lib/cloud-links), which
// shows the order before anybody pays. The app takes no payment.
//
// The pack's price is read from the catalogue the gate loads; without an
// answer from the server the card names no number (lib/cloud-pitch keeps no
// pack sizes). The subscription's monthly price is the one CLOUD_PITCH holds.

import { ExternalLink } from 'lucide-react'
import { useEffect } from 'react'
import { CLOUD_PITCH } from '../../lib/cloud-pitch'
import { gatePackEur } from '../../lib/cloud-gate'
import type { CheckoutOrder } from '../../lib/cloud-links'
import { useCloudGateStore, refreshGateCatalog } from '../../stores/cloudGateStore'

export interface BuyChoiceProps {
  onPick: (order: CheckoutOrder) => void
  /** The gate is light and dark, the Create sheet is always dark. */
  tone?: 'gate' | 'sheet'
  /** The sheets of the Character area: words only, the LU mark is their one picture. */
  plain?: boolean
}

const eur = (n: number) => `€${n.toLocaleString('en-US')}`

/** The words of the two cards, for the panel and its tests. */
export function buyChoiceCards(packEur: number | null): { order: CheckoutOrder; title: string; price: string; note: string; button: string }[] {
  return [
    {
      order: 'sub',
      title: 'Subscription',
      price: `${eur(CLOUD_PITCH.hostedMonthlyEUR)} / month`,
      note: 'Cancel anytime',
      button: 'Subscribe',
    },
    {
      order: 'pack',
      title: 'Credit pack',
      price: packEur !== null ? `${eur(packEur)} once` : 'One payment',
      note: 'No subscription',
      button: 'Buy pack',
    },
  ]
}

export function BuyChoice({ onPick, tone = 'gate', plain = false }: BuyChoiceProps) {
  const offers = useCloudGateStore((s) => s.catalog?.offers ?? null)
  // The gate loads the catalogue with its model lists (GateModels); the
  // Create sheet has none, so it asks here. A failure keeps the card without
  // a pack price.
  useEffect(() => {
    if (tone === 'sheet') void refreshGateCatalog().catch(() => {})
  }, [tone])
  const cards = buyChoiceCards(gatePackEur(offers))
  const sheet = tone === 'sheet'
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="buy-choice">
      {cards.map((c) => (
        <div
          key={c.order}
          data-order={c.order}
          className={
            sheet
              ? 'rounded-lg border border-white/10 p-2.5 flex flex-col gap-2'
              : 'rounded-lg border border-gray-200 dark:border-white/10 p-2.5 flex flex-col gap-2'
          }
        >
          <div className="text-center">
            <p className={sheet ? 't-micro font-semibold uppercase tracking-wide text-gray-400' : 't-micro font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400'}>
              {c.title}
            </p>
            <p className={sheet ? 't-body font-semibold text-white' : 't-body font-semibold text-gray-900 dark:text-white'} data-testid={`buy-price-${c.order}`}>
              {c.price}
            </p>
            <p className={sheet ? 't-micro text-gray-400' : 't-micro text-gray-500 dark:text-gray-400'}>{c.note}</p>
          </div>
          <button
            type="button"
            onClick={() => onPick(c.order)}
            data-testid={`buy-${c.order}`}
            className={
              sheet
                ? 'mt-auto w-full flex items-center justify-center gap-1.5 h-8 rounded-lg bg-white text-black t-control font-semibold hover:bg-gray-200 transition-colors'
                : 'mt-auto w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg t-control bg-lu-cloud text-white hover:opacity-90 transition-opacity'
            }
          >
            {!plain && <ExternalLink size={12} />} {c.button}
          </button>
        </div>
      ))}
    </div>
  )
}
