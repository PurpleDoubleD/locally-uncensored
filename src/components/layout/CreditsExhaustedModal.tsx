import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { ModalActions, ModalButton } from '../ui/ModalActions'
import { CREDITS_EXHAUSTED_EVENT, PRICING_LINK, type ExhaustedReason } from '../../lib/credits-exhausted'
import { CLOUD_SUBSCRIBER_LINE } from '../../lib/cloud-pitch'
import { openExternal } from '../../api/backend'

/**
 * Globally mounted "out of credits" dialog. The OpenAI provider and the cloud
 * Create hooks fire CREDITS_EXHAUSTED_EVENT for one of three server codes
 * (lib/credits-exhausted.ts); this turns it into a readable next step instead
 * of a dead-end error line. The title and body follow the reason carried on
 * the event, matching the web app
 * (R5-51): the same refusal must not read differently on the two apps.
 *
 * R5-51, Entscheid vom 12.09.2026: der Knopf oeffnet die PREISSEITE im
 * Browser, nicht die Aufladeseite, fuer alle drei Gruende. Wer leer ist,
 * waehlt zwischen einem Plan und einem Paket; ein Knopf, der direkt in einen
 * Kauf springt, nimmt ihm diese Wahl ab. Gekauft wird auf der Website; ein
 * In-Dialog-Kauf wie im Web ist eine eigene Entscheidung fuer eine spaetere
 * Runde, nicht Teil dieses Fixes.
 */
export function CreditsExhaustedModal() {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ExhaustedReason>('credits')

  useEffect(() => {
    const show = (e: Event) => {
      const r = (e as CustomEvent<{ reason?: ExhaustedReason }>).detail?.reason
      setReason(r ?? 'credits')
      setOpen(true)
    }
    window.addEventListener(CREDITS_EXHAUSTED_EVENT, show)
    return () => window.removeEventListener(CREDITS_EXHAUSTED_EVENT, show)
  }, [])

  const title =
    reason === 'video_budget'
      ? "This month's video budget is used up"
      : reason === 'trainings'
        ? 'Top up to keep training'
        : "You're out of credits"

  return (
    <Modal open={open} onClose={() => setOpen(false)} title={title}>
      <div className="space-y-4">
        {reason === 'trainings' ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Your included trainings refill on the next renewal date. Top-up
            credits can fund another training now, never expire, and work
            without a subscription.
          </p>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {reason === 'video_budget'
              ? 'Your plan credits are fine, but the monthly video budget is spent. Top-up credits are not part of that budget: they fund video directly, never expire, and are used only after your plan credits.'
              : 'Your plan credits for this billing period are used up. They refill on your next renewal date. Top-up credits are one-time, never expire, and are only used after your plan credits.'}
          </p>
        )}
        {/* Hier werden gleich Pakete angeboten, also steht daneben, was ein Abo
            je Euro mehr bringt. Zeichengleich mit dem Verkaufs-Panel, dem
            Versionsblatt und dem CHANGELOG, aus einer Konstante, deren Faktor
            aus den Pack- und Plantabellen geteilt wird (lib/cloud-pitch.ts).
            Dasselbe tut das Web-Repo auf seinen vier Paketflaechen. */}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {CLOUD_SUBSCRIBER_LINE}
        </p>
        <ModalActions>
          <ModalButton variant="quiet" onClick={() => setOpen(false)}>
            Not now
          </ModalButton>
          <ModalButton
            variant="primary"
            data-autofocus
            onClick={() => {
              void openExternal(PRICING_LINK)
              setOpen(false)
            }}
          >
            <Zap size={14} />
            See plans and packs
          </ModalButton>
        </ModalActions>
      </div>
    </Modal>
  )
}
