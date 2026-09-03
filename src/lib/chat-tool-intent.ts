/**
 * Curated tools in PLAIN chat (David 2026-06-11: "web search web fetch file
 * write und image und video mcp sollen auch im normalen chat funktionieren").
 *
 * Plain chat should be able to reach a small, fixed set of capabilities WITHOUT
 * the user flipping the full Agent toggle. Rather than expose every agent tool
 * on every message (which degrades pure conversation and over-triggers small
 * models), we detect when a message clearly needs one of these five
 * capabilities and route just that turn through the agent executor with a
 * curated allow-list + a chat-style prompt. Everything else stays on the fast
 * plain-chat path, untouched.
 *
 * The detector is intentionally capability-specific: a greeting, an
 * explanation request, or normal Q&A must NOT match (otherwise every message
 * would route through the tool loop). It errs toward the concrete signals a
 * user gives when they actually want a web lookup, a file written, or an
 * image/video made — in both English and German.
 */

/** The exact tools surfaced in plain chat. Order is irrelevant. */
export const CHAT_TOOLS = [
  'web_search',
  'web_fetch',
  'file_write',
  'image_generate',
  'video_generate',
] as const

export type ChatToolCapability = 'image' | 'video' | 'web' | 'file'

/**
 * Umlaute und Eszett auf ihre Ersatzschreibung bringen, BEVOR irgendein Muster
 * greift (Persona-Lauf 03.09.2026).
 *
 * Zwei Gruende. Erstens tippen viele Leute deutsch ohne Umlaute, aus Gewohnheit
 * oder auf fremder Tastatur; ein Muster, das auf "oeffne" in Umlautschreibung
 * besteht, verfehlt die dann jedes Mal. Zweitens, und schlimmer: eine
 * Wortgrenze vor einem Umlaut greift in JavaScript nie, weil Umlaute keine
 * Wortzeichen sind. Das alte Muster fuer "oeffne" stand mit Wortgrenze davor
 * und war damit toter Buchstabe, auch bei korrekter Schreibung. Deshalb wird
 * EINMAL zentral normalisiert und jedes Muster unten in der Ersatzschreibung
 * gefuehrt.
 */
export function entumlauten(s: string): string {
  return s
    .replace(/\u00e4/g, 'ae')
    .replace(/\u00f6/g, 'oe')
    .replace(/\u00fc/g, 'ue')
    .replace(/\u00df/g, 'ss')
}

const lower = (s: string) => entumlauten((s || '').toLowerCase())

// A bare URL or an explicit "open/read this page" → web_fetch territory.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(com|org|net|io|dev|ai|de|co|gov|edu|app|news)\b(\/\S*)?/i
//
// Die deutsche Verbliste kannte lange nur oeffne/lies/fasse/ruf...auf, und die
// URL-Regel darunter fuehrte eine zweite, kuerzere Kopie davon. Eine Persona
// tippte am 03.09.2026 zweimal "Hol bitte die Seite ..." und bekam beide Male
// gar kein tools-Feld im Payload, waehrend derselbe Satz auf Englisch sauber
// lief. Das Verb, das man am ehesten tippt, fehlte schlicht in beiden Listen.
// Der Wortstamm steht deshalb jetzt an genau einer Stelle.
const WEB_ZUGRIFF_VERBEN =
  'open|read|fetch|scrape|summari[sz]e|get|visit|check|' +
  // Trennbare Verben: im Deutschen steht die Vorsilbe am Satzende ("Ruf die
  // Webseite example.com AUF"), das alte Muster verlangte sie direkt hinter
  // dem Verb und traf damit nur unnatuerliche Saetze.
  'oeffne|lies|lese|fasse|zusammenfass\\w*|ruf(e|st|t)?|auf-?ruf\\w*|hol(e|st|t)?|abruf\\w*|' +
  'besuch(e|st|t)?|lad(e|est)?|zeig(e|st)?|schau|guck|sieh|ansehen|anschauen'
const FETCH_VERB_RE = new RegExp(
  `\\b(${WEB_ZUGRIFF_VERBEN})\\b[^.?!]*\\b(page|site|website|link|url|article|seite|webseite|artikel)\\b`,
  'i',
)
/** Derselbe Verbstamm, aber neben einer echten URL. Da braucht es kein Substantiv. */
const URL_VERB_RE = new RegExp(`\\b(${WEB_ZUGRIFF_VERBEN})\\b`, 'i')

// Search intent: explicit search verbs, or a freshness/lookup signal that a
// model cannot answer reliably from training memory.
const SEARCH_VERB_RE = /\b(search|google|look\s*up|web\s*search|search\s+the\s+web|such(e|en)?|google(n|st)?|recherchier\w*|nachschlagen|find\s+(online|on\s+the\s+web))\b/i
// Freshness only triggers a search when it modifies a lookup-ish noun — bare
// "today"/"now" in conversational phrasing ("how are you today") must not.
const FRESHNESS_RE = /\b(latest|newest|current(ly)?|today'?s?|tonight|right\s+now|recent(ly)?|breaking|in\s+20\d\d|as\s+of\s+(today|now)|aktuell\w*|neueste\w*|heutige\w*)\b/i
const FRESH_TOPIC_RE = /\b(version|release|update|news|results?|winner|champion|election|launch|price|prices|stock|standings|score|scores|ranking|patch|driver(s)?|model(s)?|treiber)\b/i
// Die Substantivliste oben kennt Seite, Webseite und Artikel, also das
// EINZELNE Dokument. Sie kannte kein einziges Wort fuer das Internet selbst.
// Genau so tippen Kunden aber, wenn sie keine bestimmte Adresse im Kopf haben:
// "schau im Netz nach", "hol mir das aus dem Internet", "schau online nach".
// Alle drei liefen ins Leere, das Modell bekam kein tools-Feld und erfand die
// Antwort, statt zu suchen. Belegt am 03.09.2026 an fuenf von fuenf Versuchen.
//
// Die Praeposition ist Absicht: sie trennt das Ziel vom Thema. "Schau im Netz
// nach" meint das Internet, "erklaer mir den Unterschied zwischen Netz und
// Graph" meint es nicht.
const NETZ_ZIEL_RE = /\b(im|ins|aus\s+dem|beim|uebers|ueber\s+das)\s+(netz|internet|web)\b|\bonline\b/i
// Nachschlagende Verben. Zusammengeschriebene Formen brauchen einen eigenen
// Eintrag, weil die Wortgrenze "schau" in "nachschauen" nicht findet.
const NETZ_VERB_RE = /\b(nach-?schau\w*|nach-?seh\w*|nach-?guck\w*|nach-?les\w*|schau(e|st)?|guck(e|st)?|sieh|such(e|en|st)?|hol(e|st|t)?|find(e|en|est)?|recherchier\w*|pruef(e|en|st)?|check(e|en)?|look|search|find)\b/i
const LOOKUP_TOPIC_RE = /\b(weather|temperature|forecast|price\s+of|stock\s+price|exchange\s+rate|who\s+won|who\s+is\s+winning|standings|release\s+date|wetter|preis\s+von|kurs\s+von|wer\s+hat\s+gewonnen|wechselkurs)\b/i

// Verbs that inherently mean "make an image" even without a media noun
// ("draw a cat", "zeichne eine Blume").
// "mal" ohne Endung ist im Deutschen meistens gar kein Verb, sondern die
// Partikel: "erklaer mir mal", "sag mal", "warte mal". Als Malen-Befehl zaehlt
// es deshalb nur am SATZANFANG, wo es wirklich Befehlsform ist ("Mal eine
// Blume"). Vorher kaperte jede beilaeufige deutsche Frage die Bildgenerierung,
// und ein Fehlalarm ist teuer: der Zug laeuft dann durch den
// Werkzeug-Ausfuehrer, woran sich kleine Modelle nachweislich verschlucken.
// "Mal mir ein Bild" bleibt auch mitten im Satz erkannt, das faengt die
// Verb-plus-Substantiv-Regel darunter.
const INHERENT_IMAGE_VERB_RE = /\b(draw|sketch|paint|illustrate|mal(e|en)|zeichne(n|st)?|skizzier\w*)\b|^\s*mal\b/i

// Image / video creation: a creation verb co-occurring with a media noun.
const CREATE_VERB_RE = /\b(draw|sketch|paint|generate|create|make|render|design|give\s+me|show\s+me|produce|turn|convert|mal(e|en)?|zeichne|erstell(e|en)?|generier(e|en)?|mach(e|en)?|gib\s+mir|zeig(e|en)?\s+mir|entwirf|produzier(e|en)?|verwandle|wandle)\b/i
const IMAGE_NOUN_RE = /\b(image|picture|pic|photo(graph)?|drawing|art(work)?|illustration|portrait|wallpaper|logo|icon|render|painting|bild(er)?|foto(s)?|grafik(en)?|zeichnung(en)?|gem[äa]lde|portr[äa]t|illustration(en)?)\b/i
const VIDEO_NOUN_RE = /\b(video|clip|animation|movie|gif|film|animier\w*|animate)\b/i
const ANIMATE_RE = /\banimate\b[^.?!]*\b(image|picture|photo|it|this|that)\b|\banimier\w*\b[^.?!]*\b(bild|foto|es|das)\b/i

// File creation: a write/save verb co-occurring with a file noun or an explicit
// filename + extension.
const FILE_VERB_RE = /\b(write|save|create|generate|put|export|dump|store|schreib(e|en)?|speicher(e|n|st)?|erstell(e|en)?|leg\w*\s+an|exportier(e|en)?|sichere)\b/i
const FILE_NOUN_RE = /\b(a\s+|an\s+|the\s+|eine?\s+|die\s+)?(file|files|datei(en)?|textfile|text\s+file|markdown|csv|json\s+file)\b/i
const FILENAME_RE = /\b[\w.-]+\.(txt|md|markdown|html?|css|js|ts|json|csv|xml|yaml|yml|py|sh|rs|toml|ini|log|svg|sql)\b/i
const SAVE_TO_FILE_RE = /\b(save|write|export|dump|speicher\w*|schreib\w*)\b[^.?!]*\b(to|into|as|in)\b[^.?!]*\b(file|datei|disk|\.\w{1,5})\b/i

/**
 * Returns the capability a plain-chat message is asking for, or null if the
 * message is ordinary conversation that should stay on the plain path.
 * `hasImages` is true when the user attached an image — slightly biases the
 * media branch toward video (animate-this-image) but is not required.
 */
export function detectChatToolCapability(text: string, hasImages = false): ChatToolCapability | null {
  const t = lower(text).trim()
  if (!t) return null

  // VIDEO first (a video request often also contains an image-ish noun like
  // "animate this picture into a video"; resolving video first avoids
  // misrouting those to image generation).
  if (CREATE_VERB_RE.test(t) && VIDEO_NOUN_RE.test(t)) return 'video'
  if (ANIMATE_RE.test(t)) return 'video'
  if (hasImages && /\b(animate|animier\w*|bring\s+to\s+life|make\s+it\s+move|in\s+ein\s+video)\b/i.test(t)) return 'video'

  // IMAGE
  if (CREATE_VERB_RE.test(t) && IMAGE_NOUN_RE.test(t)) return 'image'
  if (INHERENT_IMAGE_VERB_RE.test(t)) return 'image'

  // FILE WRITE
  if (FILENAME_RE.test(t) && FILE_VERB_RE.test(t)) return 'file'
  if (SAVE_TO_FILE_RE.test(t)) return 'file'
  if (FILE_VERB_RE.test(t) && FILE_NOUN_RE.test(t)) return 'file'

  // WEB FETCH (explicit page/url) — before generic search so a URL routes to
  // fetch, not search.
  if (FETCH_VERB_RE.test(t)) return 'web'
  if (URL_RE.test(t) && URL_VERB_RE.test(t)) return 'web'

  // WEB SEARCH
  if (SEARCH_VERB_RE.test(t)) return 'web'
  if (LOOKUP_TOPIC_RE.test(t)) return 'web'
  // Ein Netz-Wort plus ein nachschlagendes Verb ist eine Recherche, auch ohne
  // Suchverb und ohne Adresse.
  if (NETZ_ZIEL_RE.test(t) && NETZ_VERB_RE.test(t)) return 'web'
  // Freshness only counts when it actually modifies a lookup-ish topic, so
  // "what is the latest python version" routes but "how are you today" does not.
  if (FRESHNESS_RE.test(t) && FRESH_TOPIC_RE.test(t)) return 'web'

  return null
}

/** Convenience boolean wrapper for the router in useChat. */
export function detectChatToolIntent(text: string, hasImages = false): boolean {
  return detectChatToolCapability(text, hasImages) !== null
}

// ── Context-aware media continuation (David 2026-06-20) ────────────────
//
// The single-message detector above is blind to conversation context: once a
// media task is underway, the natural FOLLOW-UPS a user types carry no
// verb+noun and so DON'T match — "ok go", "2 seconds just zoom in", "nochmal
// neu", "ok generiere jetzt". Those then fell through to the plain chat path
// where the image/video tool isn't available, so the model either reasoned in
// circles ("plan stuck in thinking") or wrote a confident "(generating…)" lie
// and produced nothing. The helpers below let the router recognise such a
// follow-up AS a continuation of the in-progress media task and route it (with
// the original generation's args) back through the tool executor.

// Praise / thanks / explicit stop — these END a media exchange and must NEVER
// be treated as "do it again".
const CONT_EXIT_RE = /\b(thanks|thank\s*you|danke|thx|bye|tsch[üu]ss|cool|nice|great|super|perfekt|perfect|stop|stopp|cancel|abbrechen|nevermind|egal|vergiss\s+es)\b/i

// STRONG signals push a media task forward at ANY length (redo / motion / a bare
// create verb without a noun).
const STRONG_CONT_RE = /\b(re-?generate|regenerier\w*|nochmal|noch\s*mal|neu|erneut|redo|again|zoom|spin|rotate|\bpan\b|animate|animier\w*|longer|shorter|faster|slower|l[äa]nger|k[üu]rzer|schneller|langsamer|generier\w*|generate)\b/i
// WEAK signals (confirmations / "now") only count in a SHORT message, so "now"
// inside "now tell me about cats" never hijacks the media tool.
const WEAK_CONT_RE = /\b(go|do\s*it|yes|yep|yeah|sure|ok(ay)?|los|mach(\s*(es|mal|schon))?|tu\s*es|proceed|continue|weiter|jetzt|now|please|bitte|create|erstell\w*|render|produce|produzier\w*)\b/i
// Bare duration like "2 seconds" / "3s" — only sensible as a clip follow-up.
const BARE_DURATION_RE = /^\s*\d+\s*(s|sec|secs|seconds?|sek|sekunden?|min|minuten?)?\s*$/i
// A short complaint that nothing was produced should re-trigger the task.
const CONT_COMPLAINT_RE = /\b(nix|nichts|nicht|kein\w*|nothing|didn'?t|doesn'?t|won'?t)\b/i

/**
 * True when `text`, ON ITS OWN, is a follow-up that should advance an
 * already-running media task (caller must confirm there IS one — see
 * resolveChatToolRoute). Deliberately conservative for weak signals.
 */
export function isMediaContinuation(text: string): boolean {
  const t = lower(text).trim()
  if (!t) return false
  if (CONT_EXIT_RE.test(t)) return false
  if (BARE_DURATION_RE.test(t)) return true
  if (STRONG_CONT_RE.test(t)) return true
  const wordCount = t.split(/\s+/).length
  if (WEAK_CONT_RE.test(t) && wordCount <= 4) return true
  if (CONT_COMPLAINT_RE.test(t) && wordCount <= 6) return true
  return false
}

/** A recent message, reduced to what the router needs (decoupled from Message). */
export interface ChatToolRouteMsg {
  role: string
  content: string
  /** Set on assistant turns that produced media — the tool kind + its exact args
   *  so a bare "nochmal"/"again" can reproduce the SAME media deterministically. */
  mediaKind?: 'image' | 'video'
  mediaArgs?: Record<string, unknown>
}

export interface ChatToolRoute {
  capability: ChatToolCapability
  /** Present for media routes; `args` carries the prior generation's parameters
   *  (prompt, inputImage, duration…) for a faithful regenerate. */
  mediaHint?: { kind: 'image' | 'video'; args?: Record<string, unknown> }
}

/** How far back to look for the in-progress media task. */
const MEDIA_CONTEXT_WINDOW = 12

/**
 * Decide whether a plain-chat message should run through the chat-tools
 * executor — directly (verb+noun in this message) OR as a continuation of a
 * recent image/video task. `recent` is the conversation history BEFORE this
 * message (oldest→newest); the most recent entry is last.
 */
export function resolveChatToolRoute(
  text: string,
  hasImages: boolean,
  recent: ChatToolRouteMsg[],
): ChatToolRoute | null {
  const direct = detectChatToolCapability(text, hasImages)
  if (direct) {
    return direct === 'image' || direct === 'video'
      ? { capability: direct, mediaHint: { kind: direct } }
      : { capability: direct }
  }
  if (!isMediaContinuation(text)) return null

  const window = recent.slice(-MEDIA_CONTEXT_WINDOW)
  for (let i = window.length - 1; i >= 0; i--) {
    const m = window[i]
    // A prior assistant turn that actually produced media wins — reuse its args.
    if (m.role === 'assistant' && (m.mediaKind === 'image' || m.mediaKind === 'video')) {
      return { capability: m.mediaKind, mediaHint: { kind: m.mediaKind, args: m.mediaArgs } }
    }
    // Otherwise an earlier user message that asked for media establishes the kind.
    if (m.role === 'user') {
      const cap = detectChatToolCapability(m.content)
      if (cap === 'image' || cap === 'video') return { capability: cap, mediaHint: { kind: cap } }
    }
  }
  return null
}
