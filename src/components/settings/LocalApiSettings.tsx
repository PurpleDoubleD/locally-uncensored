import { useEffect, useState } from 'react'
import { Copy, Check, KeyRound, Eye, EyeOff, Globe, ChevronDown, ChevronRight } from 'lucide-react'
import { useLocalApiStore } from '../../stores/localApiStore'
import {
  localApiBaseUrl, curlBeispiel, clientFelder, reichweiteText, kannStarten, pruefePort,
  corsText, nutzungZeilen, ohneZahlenText, clientAnleitung, type LocalApiNutzung,
} from '../../lib/local-api'
import { backendCall } from '../../api/backend'
import { InlineToggle } from './InlineToggle'
import { HINWEIS_TEXT } from '../../lib/hinweis'

/**
 * Die lokale Modell-API zum Ein- und Ausschalten.
 *
 * Die Rechnerei steht in lib/local-api.ts, damit sie geprueft ist — hier steht
 * nur, was man sieht.
 *
 * SICHTBARER TEXT IST ENGLISCH. Das musste ich mir am 02.09.2026 selbst
 * beibringen: dieses Panel war die EINZIGE Stelle im ganzen Projekt mit
 * deutscher Oberflaeche, und es ist mir erst aufgefallen, als ich die App im
 * Browser aufgemacht und hingesehen habe. Kein Test dieses Hauses rendert ein
 * `.tsx`, also hat keiner es gemeldet — 8.671 gruene Tests und trotzdem ein
 * Panel in der falschen Sprache. Kommentare und Bezeichner bleiben deutsch,
 * das ist Hausstil; was der Nutzer liest, nicht. Beispielmodell in der curl-Zeile ist bewusst ein
 * qualifizierter Name: wer ihn kopiert, lernt die Namensform gleich mit.
 */
export function LocalApiSettings() {
  const { port, lan, token, corsOrigins, mitLuStarten, laeuft, fehler, setPort, setLan, setCors, setMitLuStarten, neuesToken, starten, stoppen, auffrischen } = useLocalApiStore()
  const [zeigeToken, setZeigeToken] = useState(false)
  const [kopiert, setKopiert] = useState<string | null>(null)
  const [anleitungOffen, setAnleitungOffen] = useState(false)
  // Der Rohtext bleibt lokal: gespeichert wird nur, was die Pruefung
  // uebersteht. Sonst stuende in der Datei eine Freigabe, die nie greift.
  const [corsRoh, setCorsRoh] = useState(corsOrigins.join(', '))

  useEffect(() => { auffrischen() }, [auffrischen])

  // GH Discussion #4: what went through the API since it started.
  // Asked every three seconds while it runs and the panel is open.
  // Mit dem Zeitpunkt des Abrufs, damit "vor wie langem" nicht im Rendern rechnet.
  const [nutzung, setNutzung] = useState<{ u: LocalApiNutzung; jetzt: number } | null>(null)
  useEffect(() => {
    // Gestoppt: nichts fragen. Das Feld blendet sich ueber `laeuft` aus, und
    // ein Neustart holt sofort frische Zahlen.
    if (!laeuft) return
    let aus = false
    const holen = async () => {
      try {
        const u = await backendCall<LocalApiNutzung & { running?: boolean }>('local_api_usage')
        if (!aus) setNutzung(u.running === false ? null : { u, jetzt: Date.now() })
      } catch { /* die Zahlen sind Beiwerk, die API laeuft auch ohne */ }
    }
    void holen()
    const t = setInterval(holen, 3000)
    return () => { aus = true; clearInterval(t) }
  }, [laeuft])

  const base = localApiBaseUrl(port, lan)
  const startbar = kannStarten(token, port)
  const portUrteil = pruefePort(port)

  const kopiere = async (was: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setKopiert(was)
      setTimeout(() => setKopiert(null), 1400)
    } catch { /* ohne Zwischenablage bleibt der Text sichtbar */ }
  }

  return (
    <div className="space-y-3">
      <p className="t-micro text-gray-600">
        One OpenAI-compatible address for every model on this machine: LU Engine, Ollama
        and LM Studio under a single URL. Anything that can talk to OpenAI can talk to your
        local models through it. It always needs the API key LU generates below, also on
        this machine.
      </p>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-medium">Local API</div>
          <div className="t-micro text-gray-600">{reichweiteText(lan)}</div>
        </div>
        <button
          onClick={() => (laeuft ? stoppen() : starten())}
          disabled={!laeuft && !startbar.ok}
          data-testid="local-api-toggle"
          className={`px-3 py-1.5 rounded text-xs transition-colors ${
            laeuft
              ? 'bg-red-600/80 hover:bg-red-600 text-white'
              : startbar.ok
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          }`}
        >
          {laeuft ? 'Stop' : 'Start'}
        </button>
      </div>

      {/* Beide Zeilen halten den Start auf, also tragen sie denselben Ton: wer
          hier nichts tut, bekommt keine API. Frueher stand die obere in Gelb
          und die untere in Rot, obwohl beide dasselbe verlangen. */}
      {!startbar.ok && !laeuft && (
        <div className={`t-micro ${HINWEIS_TEXT.fehler}`}>{startbar.grund}</div>
      )}
      {fehler && <div className={`t-micro ${HINWEIS_TEXT.fehler}`}>{fehler}</div>}

      {laeuft && nutzung && (
        <div className="space-y-1" data-testid="local-api-usage">
          <div className="t-micro text-gray-500">Since the API started</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {nutzungZeilen(nutzung.u, nutzung.jetzt).map(({ feld, wert }) => (
              <div key={feld} className={`flex items-center justify-between gap-2 ${feld === 'Last model' ? 'col-span-2' : ''}`}>
                <span className="t-micro text-gray-500">{feld}</span>
                <span className="t-mono text-gray-300 truncate" title={wert}>{wert}</span>
              </div>
            ))}
          </div>
          {ohneZahlenText(nutzung.u) && <div className="t-micro text-gray-600">{ohneZahlenText(nutzung.u)}</div>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="t-micro text-gray-500">
          Port
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            disabled={laeuft}
            className="mt-1 w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs disabled:opacity-50"
          />
          {!portUrteil.ok && <span className={`block mt-1 ${HINWEIS_TEXT.fehler}`}>{portUrteil.grund}</span>}
        </label>
        <div className="t-micro text-gray-500">
          Reachable on the network
          <div className="mt-1">
            <InlineToggle
              enabled={lan}
              onChange={() => setLan(!lan)}
              label={lan ? 'LAN' : 'this machine only'}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="t-micro text-gray-500">Start with LU</div>
          <div className="t-micro text-gray-600">Starts the API every time LU opens, with the settings above. Useful when LU runs on a server.</div>
        </div>
        <InlineToggle
          enabled={mitLuStarten}
          onChange={() => setMitLuStarten(!mitLuStarten)}
          label={mitLuStarten ? 'on' : 'off'}
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Globe className="w-3 h-3 text-gray-500" />
          <span className="t-micro text-gray-500">
            Browser access. Leave empty if no web page should use the API.
          </span>
        </div>
        <input
          value={corsRoh}
          onChange={(e) => { setCorsRoh(e.target.value); setCors(e.target.value) }}
          onBlur={() => setCorsRoh(corsOrigins.join(', '))}
          disabled={laeuft}
          placeholder="http://localhost:3000"
          className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 t-mono text-xs disabled:opacity-50"
        />
        <div className="t-micro text-gray-600">{corsText(corsOrigins)}</div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="w-3 h-3 text-gray-500" />
          <span className="t-micro text-gray-500">API key. LU makes it, you do not choose one. Every request needs it, also from this machine: paste it into your app's API key field.</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            readOnly
            type={zeigeToken ? 'text' : 'password'}
            value={token}
            placeholder="none yet"
            className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs font-mono"
          />
          <button onClick={() => setZeigeToken((v) => !v)} className="p-1 text-gray-500 hover:text-gray-300" title={zeigeToken ? 'Hide' : 'Show'}>
            {zeigeToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => kopiere('token', token)} disabled={!token} className="p-1 text-gray-500 hover:text-gray-300 disabled:opacity-30" title="Copy">
            {kopiert === 'token' ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => neuesToken()} disabled={laeuft} className="px-2 py-1 rounded t-micro bg-white/5 hover:bg-white/10 disabled:opacity-40">
            {token ? 'New' : 'Generate'}
          </button>
        </div>
      </div>

      {token && (
        <div className="space-y-2 pt-1">
          {clientFelder(base, token).map(({ feld, wert }) => (
            <div key={feld} className="flex items-center gap-2">
              <span className="w-16 shrink-0 t-micro text-gray-500">{feld}</span>
              <code className="flex-1 truncate bg-black/30 border border-white/10 rounded px-2 py-1 t-mono">
                {feld === 'API Key' && !zeigeToken ? '•'.repeat(16) : wert}
              </code>
              <button onClick={() => kopiere(feld, wert)} className="p-1 text-gray-500 hover:text-gray-300" title="Copy">
                {kopiert === feld ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          ))}
          <button
            onClick={() => kopiere('curl', curlBeispiel(base, token, 'ollama/smollm2:135m'))}
            className="t-micro text-blue-400 hover:text-blue-300"
          >
            {kopiert === 'curl' ? 'Copied' : 'Copy an example call (curl)'}
          </button>
        </div>
      )}

      {/* GH Discussion #14 und C57: wer SillyTavern oder eine andere App
          anschliesst, soll hier lesen koennen, welches Feld welches ist. */}
      <div className="pt-1">
        <button
          onClick={() => setAnleitungOffen((v) => !v)}
          aria-expanded={anleitungOffen}
          data-testid="local-api-howto"
          className="flex items-center gap-1 t-micro text-gray-400 hover:text-gray-200"
        >
          {anleitungOffen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Use with SillyTavern / other apps
        </button>
        {anleitungOffen && (
          <div className="mt-2 space-y-2">
            {clientAnleitung(base).map((a) => (
              <div key={a.titel}>
                <div className="t-micro text-gray-400">{a.titel}</div>
                <ol className="list-decimal pl-4 space-y-0.5">
                  {a.schritte.map((s) => (
                    <li key={s} className="t-micro text-gray-500 break-words">{s}</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
