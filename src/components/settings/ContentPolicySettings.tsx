import { useCallback, useEffect, useState } from 'react'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { getContentPolicy, setContentPolicy, type ContentPolicy } from '../../api/cloud/jobs'
import { useCloudAuthStore } from '../../stores/cloudAuthStore'
import { primeContentPolicyCache } from '../../hooks/useContentPolicy'

/*
 * Der Zusatz am Off-Hinweis haengt am Schalter des Servers. Ein Satz, der eine
 * Bestaetigung ankuendigt, die nicht mehr kommt, verspricht genau das, was die
 * Oberflaeche nicht mehr tut. Gleicher Bau wie im Web.
 *
 * Wortlaut (R5-5, R5-6): identisch mit the web app,
 * ein Wortlaut ist besser als zwei. Das Wort
 * "filter" bleibt hier erlaubt, anders als in der oeffentlichen Doku unter
 * docs/: die Regel gegen das Wort gilt der Zahlungsdomain, nicht dieser App.
 */
function options(bestaetigungNoetig: boolean): { value: ContentPolicy; label: string; hint: string }[] {
  return [
    { value: 'strict', label: 'Strict', hint: 'The strictest setting we have. Choose this if others use your screen.' },
    { value: 'soft', label: 'Standard', hint: 'The default for every account.' },
    {
      value: 'off',
      label: 'Off',
      hint: bestaetigungNoetig
        ? 'Only the legal limits below apply. Requires an age confirmation.'
        : 'Only the legal limits below apply.',
    },
  ]
}

/**
 * Die Inhaltsrichtlinie des Kontos, hier und in der Webanwendung dieselbe.
 *
 * Der Server entscheidet. Diese Steuerung schickt einen Wunsch und zeigt, was
 * zurueckkommt; sie haelt keinen eigenen Zustand vor, den der Server nicht
 * kennt. Wer sie faelscht, faelscht eine Beschriftung, keinen Zugang: die
 * Auftragsroute liest die Datenbank bei jedem Auftrag neu.
 *
 * Die gesetzlichen Grenzen sind kein Teil der Wahl. Sie gelten bei jedem Wert.
 */
export function ContentPolicySettings() {
  const signedIn = useCloudAuthStore((s) => s.status === 'signed-in')
  const [policy, setPolicy] = useState<ContentPolicy>('soft')
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null)
  /*
   * Vorsichtiger Standard: bis der Server widerspricht, wird gefragt. Siehe die
   * Begruendung in api/cloud/jobs.ts; eine Antwort, die nicht ankommt, darf die
   * Schranke nicht abraeumen.
   */
  const [requiresAge, setRequiresAge] = useState(true)
  const [pending, setPending] = useState<ContentPolicy | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!signedIn) return
    let live = true
    getContentPolicy()
      .then((s) => {
        if (!live) return
        setPolicy(s.policy)
        setConfirmedAt(s.ageConfirmedAt)
        setRequiresAge(s.ageConfirmationRequired)
      })
      .catch(() => { /* signed out or offline: the default stands */ })
    return () => { live = false }
  }, [signedIn])

  const save = useCallback(async (next: ContentPolicy, ageConfirmed: boolean) => {
    setBusy(true)
    setError('')
    try {
      const saved = await setContentPolicy(next, ageConfirmed)
      setPolicy(saved)
      // C2: the ModelChip badge reads a separate shared cache (useContentPolicy)
      // so it does not fire its own GET per mount, push the fresh value in
      // immediately instead of leaving it to catch up on the next reload.
      primeContentPolicyCache(saved)
      /*
       * Das Bestaetigungsdatum kommt vom Server, nicht von der Uhr dieses
       * Rechners (R2-30). `setContentPolicy` gibt nur die Richtlinie zurueck,
       * weil der Server den Zeitstempel selbst setzt und ein mitgeschickter
       * wertlos waere (api/cloud/jobs.ts). Wer die Uhr seines Rechners
       * verstellt hat, las deshalb bis 3.0.0 ein Datum, das in keiner
       * Datenbank steht, und beim naechsten Laden ein anderes.
       *
       * Die zweite Anfrage ist bewusst ihr eigener Versuch: der Wunsch ist
       * gespeichert, sobald `setContentPolicy` zurueck ist. Faellt das Netz
       * genau dazwischen aus, ist das kein Fehler, den jemand zu lesen
       * bekommt, und erfunden wird hier trotzdem kein Datum.
       */
      try {
        const vomServer = await getContentPolicy()
        setPolicy(vomServer.policy)
        setConfirmedAt(vomServer.ageConfirmedAt)
      } catch {
        setConfirmedAt(null)
      }
      setPending(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the setting.')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!signedIn) {
    return (
      <p className="text-[0.6rem] text-gray-500 leading-relaxed" data-testid="content-policy-signed-out">
        Sign in to your LU Cloud account to change this setting.
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="content-policy">
      <p className="text-[0.6rem] text-gray-500 leading-relaxed">
        {/* R5-4: Web-Wortlaut fuer die ersten beiden Saetze, der dritte ist ein
            Desktop-Zusatz, den es im Web nicht braucht, weil dort nichts
            lokal rendert. */}
        Applies to images and video generated in the cloud. Text is unaffected. Nothing on your
        own machine is affected.
      </p>

      {options(requiresAge).map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name="lu-content-policy"
            className="mt-1"
            value={o.value}
            checked={policy === o.value}
            disabled={busy}
            onChange={() => {
              if (o.value === 'off' && requiresAge) setPending('off')
              else void save(o.value, false)
            }}
          />
          <span>
            <span className="text-[0.7rem] text-gray-700 dark:text-gray-300">{o.label}</span>
            <span className="block text-[0.6rem] text-gray-500 dark:text-gray-600 leading-snug">{o.hint}</span>
          </span>
        </label>
      ))}

      {pending === 'off' && (
        <div className="space-y-2 rounded-md border border-gray-200 dark:border-white/10 p-2" data-testid="age-gate">
          <p className="text-[0.6rem] text-gray-600 dark:text-gray-400">
            Confirm that you are 18 or older and that you are turning this off for yourself.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md bg-violet-500/15 px-3 py-1 text-[0.65rem] font-medium text-violet-500 dark:text-violet-300 hover:bg-violet-500/25 disabled:opacity-50"
              disabled={busy}
              onClick={() => void save('off', true)}
            >
              I am 18 or older
            </button>
            <button
              type="button"
              className="rounded-md border border-gray-200 dark:border-white/10 px-3 py-1 text-[0.65rem]"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Auch der Rueckblick haengt am Schalter. Ein Konto kann einen Stempel
          aus der Zeit tragen, in der bestaetigt wurde; ohne diese Bedingung
          spraeche die Zeile von einem Schritt, den es nicht mehr gibt. */}
      {policy === 'off' && requiresAge && confirmedAt && (
        <p className="text-[0.6rem] text-gray-500">
          Age confirmed on {new Date(confirmedAt).toLocaleDateString()}. Switching to another
          option clears that confirmation.
        </p>
      )}

      {error && <p className={`text-[0.6rem] ${HINWEIS_TEXT.fehler}`} role="alert">{error}</p>}

      <p className="text-[0.6rem] text-gray-500 leading-relaxed">
        Material involving minors is refused on every request. Uploading photographs of real
        people without their consent is not allowed.
      </p>
    </div>
  )
}
