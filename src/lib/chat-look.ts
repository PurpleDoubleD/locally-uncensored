/**
 * Chat look (3.1.0, C58 / C42): how the transcript reads.
 *
 * Who asked: micnorian14 (GitHub Discussion #14) wants enough say over the
 * chat's look to move over from SillyTavern; a Discord user wants Ctrl/Cmd +
 * wheel to zoom the chat text like a browser does.
 *
 * What SillyTavern offers (docs, "UI Theme"): free colours for main, italics,
 * underlined and quoted text, user and AI message, chat width 25-100 %, a font
 * scale of 0.5-1.5, a chat style (flat, bubbles, document), a background per
 * chat and unrestricted custom CSS. Two things go wrong there all the time:
 * a colour picked in a dark theme is unreadable in a light one, and custom
 * CSS from a shared theme can load anything from anywhere.
 *
 * LU does it this way:
 *  - Every colour is guarded: the colour shown is moved in lightness until it
 *    reaches 4.5:1 (WCAG AA) against the surface it is read on, separately in
 *    light and in dark mode. A colour can therefore never make a chat
 *    unreadable, and one look works in both modes.
 *  - Quoted speech and *actions* get their own colours (opt in).
 *  - The background picture lies under a scrim of the pane colour, so text
 *    keeps its contrast; the scrim strength is a slider with a floor.
 *  - Custom CSS goes through lib/chat-css-sanitize.ts: scoped to the
 *    transcript, no url(), no @import, no fonts or pictures from anywhere.
 *  - The zoom lives here as a number and is applied to the transcript only.
 *
 * Everything here is pure and tested (__tests__/chat-look.test.ts); the store
 * is stores/chatLookStore.ts, the surface components/chat/ChatLookScope.tsx.
 */

export type ChatFont = 'app' | 'serif' | 'sans' | 'mono' | 'custom'
export type ChatWidth = 'normal' | 'wide' | 'full'
export type ChatLayout = 'default' | 'bubbles' | 'document'

export interface ChatLook {
  /** Text colour of the model's replies; null keeps the app's colour. */
  modelText: string | null
  /** Text colour of the user's messages. */
  userText: string | null
  /** Tint of the user's bubble (and the model's in the bubbles layout). */
  userBubble: string | null
  modelBubble: string | null
  /** Colour for "quoted speech". */
  quoteText: string | null
  /** Colour for *actions* (markdown emphasis). */
  actionText: string | null
  highlightQuotes: boolean
  highlightActions: boolean
  font: ChatFont
  /** A font installed on this computer, by name. Only used with font 'custom'. */
  customFont: string
  width: ChatWidth
  layout: ChatLayout
  /** Line height of the message text. */
  lineHeight: number
  customCss: string
  customCssOn: boolean
}

export const DEFAULT_LOOK: ChatLook = {
  modelText: null,
  userText: null,
  userBubble: null,
  modelBubble: null,
  quoteText: null,
  actionText: null,
  highlightQuotes: false,
  highlightActions: false,
  font: 'app',
  customFont: '',
  width: 'normal',
  layout: 'default',
  lineHeight: 1.625,
  customCss: '',
  customCssOn: false,
}

/** The colours the guard is computed against: the pane a message is read on
 *  (index.css: #ffffff light, #1e1e1e dark). */
export const PANE = { light: '#ffffff', dark: '#1e1e1e' } as const
/** WCAG AA for body text. */
export const MIN_CONTRAST = 4.5

// ── Colour maths ─────────────────────────────────────────────────────────

export interface Rgb { r: number; g: number; b: number }

/** `#rgb` or `#rrggbb`, case-insensitive; anything else is null. */
export function parseHex(hex: string | null | undefined): Rgb | null {
  if (typeof hex !== 'string') return null
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 }
}

/**
 * The colour as close to `hex` as possible that still reads at `min` against
 * `surface`: the hue and saturation stay, the lightness moves away from the
 * surface (darker on a light pane, lighter on a dark one) in small steps.
 * An unparsable colour returns null, so the caller keeps the app's own.
 */
export function readableOn(hex: string | null | undefined, surface: string, min = MIN_CONTRAST): string | null {
  const c = parseHex(hex)
  const bg = parseHex(surface)
  if (!c || !bg) return null
  if (contrast(c, bg) >= min) return toHex(c)
  const [h, s, l0] = rgbToHsl(c)
  const darker = luminance(bg) > 0.18
  for (let i = 1; i <= 100; i++) {
    const l = darker ? l0 - (l0 * i) / 100 : l0 + ((1 - l0) * i) / 100
    const next = hslToRgb(h, s, l)
    if (contrast(next, bg) >= min) return toHex(next)
  }
  return darker ? '#000000' : '#ffffff'
}

/**
 * A bubble tint as a surface: the chosen colour laid over the pane at
 * `alpha`, so a saturated pick reads as a soft tint and stays a surface text
 * can sit on. Returns the mixed opaque colour (what the eye sees).
 */
export function tintOver(hex: string | null | undefined, pane: string, alpha = 0.16): string | null {
  const c = parseHex(hex)
  const p = parseHex(pane)
  if (!c || !p) return null
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha)
  return toHex({ r: mix(c.r, p.r), g: mix(c.g, p.g), b: mix(c.b, p.b) })
}

// ── What the transcript gets ─────────────────────────────────────────────

export type Mode = 'light' | 'dark'

const FONT_STACKS: Record<Exclude<ChatFont, 'app' | 'custom'>, string> = {
  serif: `'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif`,
  sans: `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`,
  mono: `ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace`,
}

/** A font name typed by the user, cut down to what a family name can hold.
 *  Letters (any script), digits, space, dash, dot, underscore; at most 64.
 *  Nothing else gets through, so the name can never close the declaration. */
export function cleanFontName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 64)
}

export function fontStack(look: Pick<ChatLook, 'font' | 'customFont'>): string | null {
  if (look.font === 'app') return null
  if (look.font === 'custom') {
    const name = cleanFontName(look.customFont)
    return name ? `'${name}', ${FONT_STACKS.sans}` : null
  }
  return FONT_STACKS[look.font]
}

/** Width multiplier of the transcript column; null means no cap. */
export function widthFactor(width: ChatWidth): number | null {
  if (width === 'wide') return 1.35
  if (width === 'full') return null
  return 1
}

/**
 * The CSS custom properties for the transcript in `mode`. Only colours the
 * user picked are emitted; the stylesheet falls back to the app's own colour
 * for every property that is absent (index.css, `.lu-look`).
 */
export function lookVars(look: ChatLook, mode: Mode): Record<string, string> {
  const pane = PANE[mode]
  const vars: Record<string, string> = {}
  const userBubble = look.userBubble ? tintOver(look.userBubble, pane, mode === 'dark' ? 0.22 : 0.16) : null
  const modelBubble = look.modelBubble ? tintOver(look.modelBubble, pane, mode === 'dark' ? 0.18 : 0.12) : null
  const put = (name: string, value: string | null) => { if (value) vars[name] = value }
  put('--lu-look-user-bubble', userBubble)
  put('--lu-look-model-bubble', modelBubble)
  put('--lu-look-model-text', readableOn(look.modelText, modelBubble ?? pane))
  put('--lu-look-user-text', readableOn(look.userText, userBubble ?? pane))
  // Quotes and actions sit inside either bubble: guard against the harder one.
  const harder = (hex: string | null) => {
    if (!hex) return null
    const surfaces = [pane, userBubble, modelBubble].filter((s): s is string => !!s)
    let out: string | null = hex
    for (const s of surfaces) out = readableOn(out, s)
    return out
  }
  if (look.highlightQuotes) put('--lu-look-quote', harder(look.quoteText ?? (mode === 'dark' ? '#fdba74' : '#c2410c')))
  if (look.highlightActions) put('--lu-look-action', harder(look.actionText ?? (mode === 'dark' ? '#a5b4fc' : '#4f46e5')))
  put('--lu-look-font', fontStack(look))
  if (Number.isFinite(look.lineHeight)) vars['--lu-look-leading'] = String(clamp(look.lineHeight, 1.2, 2.2))
  return vars
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Bring a stored look (any shape, from disk or an imported file) back into
 *  the type, field by field; unknown or broken fields fall back to defaults. */
export function normalizeLook(raw: unknown): ChatLook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const color = (v: unknown) => (typeof v === 'string' && parseHex(v) ? toHex(parseHex(v)!) : null)
  const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)
  return {
    modelText: color(r.modelText),
    userText: color(r.userText),
    userBubble: color(r.userBubble),
    modelBubble: color(r.modelBubble),
    quoteText: color(r.quoteText),
    actionText: color(r.actionText),
    highlightQuotes: r.highlightQuotes === true,
    highlightActions: r.highlightActions === true,
    font: oneOf(r.font, ['app', 'serif', 'sans', 'mono', 'custom'] as const, 'app'),
    customFont: typeof r.customFont === 'string' ? cleanFontName(r.customFont) : '',
    width: oneOf(r.width, ['normal', 'wide', 'full'] as const, 'normal'),
    layout: oneOf(r.layout, ['default', 'bubbles', 'document'] as const, 'default'),
    lineHeight: typeof r.lineHeight === 'number' && Number.isFinite(r.lineHeight) ? clamp(r.lineHeight, 1.2, 2.2) : DEFAULT_LOOK.lineHeight,
    customCss: typeof r.customCss === 'string' ? r.customCss.slice(0, MAX_CSS) : '',
    customCssOn: r.customCssOn === true,
  }
}

export const MAX_CSS = 20_000

/** Ready-made looks, each tested in both modes by the guard above. */
export const LOOK_PRESETS: { id: string; label: string; look: Partial<ChatLook> }[] = [
  { id: 'lu', label: 'LU default', look: {} },
  {
    id: 'story', label: 'Story',
    look: { font: 'serif', lineHeight: 1.8, highlightQuotes: true, highlightActions: true, quoteText: '#c2410c', actionText: '#6d28d9', layout: 'document' },
  },
  {
    id: 'roleplay', label: 'Roleplay',
    look: { highlightQuotes: true, highlightActions: true, quoteText: '#ea580c', actionText: '#6366f1', userBubble: '#3b82f6', layout: 'bubbles', modelBubble: '#64748b' },
  },
  {
    id: 'calm', label: 'Calm',
    look: { modelText: '#334155', userBubble: '#14b8a6', font: 'sans', lineHeight: 1.75 },
  },
  {
    id: 'contrast', label: 'High contrast',
    look: { modelText: '#000000', userText: '#000000', highlightQuotes: true, highlightActions: true, quoteText: '#9a3412', actionText: '#1d4ed8', lineHeight: 1.7 },
  },
]

// ── Zoom (C42) ───────────────────────────────────────────────────────────

export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 2
export const ZOOM_STEP = 0.1

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1
  return Math.round(clamp(z, ZOOM_MIN, ZOOM_MAX) * 100) / 100
}

/**
 * The next zoom for one wheel event with Ctrl/Cmd held. A mouse wheel sends
 * notches (|deltaY| around 100, or deltaMode lines): one step per notch, as a
 * browser does. A trackpad pinch on macOS arrives as small ctrl+wheel deltas:
 * those zoom smoothly, in proportion.
 */
export function wheelZoom(current: number, deltaY: number, deltaMode = 0): number {
  if (deltaY === 0) return clampZoom(current)
  const notch = deltaMode !== 0 || Math.abs(deltaY) >= 50
  if (notch) return clampZoom(Math.round((current + (deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)) * 10) / 10)
  return clampZoom(current * Math.exp(-deltaY * 0.01))
}

/**
 * A trackpad pinch in WebKit (the macOS app's WKWebView, Safari). WebKit does
 * not turn a pinch into ctrl + wheel the way Chromium does; it sends
 * `gesturestart` / `gesturechange` with `scale` relative to the start of the
 * gesture. The zoom follows the fingers from where the gesture began.
 */
export function gestureZoom(atStart: number, scale: unknown): number | null {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return null
  return clampZoom(atStart * scale)
}

/** Ctrl/Cmd with + / = / - / 0, as in a browser. */
export function keyZoom(current: number, key: string): number | null {
  if (key === '+' || key === '=') return clampZoom(Math.round((current + ZOOM_STEP) * 10) / 10)
  if (key === '-' || key === '_') return clampZoom(Math.round((current - ZOOM_STEP) * 10) / 10)
  if (key === '0') return 1
  return null
}

// ── Background ───────────────────────────────────────────────────────────

export interface ChatBackground {
  /** `lu-attachment:v1:<sha256>` from lib/chat-attachments (never inline). */
  ref: string
  /** How much of the pane colour lies over the picture, 0.5 to 0.95. */
  scrim: number
  /** Blur in px, 0 to 16. */
  blur: number
}

export const SCRIM_MIN = 0.5
export const SCRIM_DEFAULT = 0.72

export function bgKeyForChat(conversationId: string): string { return `chat:${conversationId}` }
export function bgKeyForPersona(personaId: string): string { return `persona:${personaId}` }

/** The chat's own picture wins over the persona's. */
export function pickBackground(
  backgrounds: Record<string, ChatBackground>,
  conversationId: string | null | undefined,
  personaId: string | null | undefined,
): { key: string; bg: ChatBackground } | null {
  if (conversationId) {
    const k = bgKeyForChat(conversationId)
    if (backgrounds[k]) return { key: k, bg: backgrounds[k] }
  }
  if (personaId) {
    const k = bgKeyForPersona(personaId)
    if (backgrounds[k]) return { key: k, bg: backgrounds[k] }
  }
  return null
}

export function normalizeBackground(b: Partial<ChatBackground>): ChatBackground | null {
  if (typeof b.ref !== 'string' || !/^lu-attachment:v1:[a-f0-9]{64}$/.test(b.ref)) return null
  return {
    ref: b.ref,
    scrim: typeof b.scrim === 'number' && Number.isFinite(b.scrim) ? clamp(b.scrim, SCRIM_MIN, 0.95) : SCRIM_DEFAULT,
    blur: typeof b.blur === 'number' && Number.isFinite(b.blur) ? clamp(Math.round(b.blur), 0, 16) : 0,
  }
}

/**
 * A prompt for a background of the current scene, made from the latest
 * reply (or the latest message): narration only. Quoted speech, markdown and
 * out-of-character notes are dropped, the rest is cut at a sentence near 400
 * characters. The user sees and edits it before anything is generated.
 */
export function scenePrompt(texts: string[]): string {
  const source = [...texts].reverse().find((t) => t && t.trim()) ?? ''
  const narration = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\(\((?:.|\n)*?\)\)|\[OOC[^\]]*\]/gi, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|„[^“”\n]*[“”]|«[^»\n]*»/g, ' ')
    .replace(/[*_#>`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let cut = narration.slice(0, 420)
  if (narration.length > 420) {
    const end = cut.lastIndexOf('. ')
    if (end > 120) cut = cut.slice(0, end + 1)
  }
  const scene = cut || 'a calm, atmospheric place'
  return `Wide background scenery, empty of people, no text, soft focus, cinematic light. Scene: ${scene}`
}
