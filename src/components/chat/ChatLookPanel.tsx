import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Palette, X, RotateCcw, Upload, Images, Sparkles, Trash2, Square, Copy, ClipboardPaste, ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'
import { useChatLookStore } from '../../stores/chatLookStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCreateStore } from '../../stores/createStore'
import { useUIStore } from '../../stores/uiStore'
import {
  DEFAULT_LOOK, LOOK_PRESETS, PANE, SCRIM_DEFAULT, SCRIM_MIN, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  bgKeyForChat, bgKeyForPersona, normalizeLook, readableOn, scenePrompt,
  type ChatFont, type ChatLayout, type ChatLook, type ChatWidth,
} from '../../lib/chat-look'
import { sanitizeChatCss } from '../../lib/chat-css-sanitize'
import { cancelSceneBackground, renderSceneBackground, storeBackground } from '../../lib/chat-background'
import { HEADER_CHIP } from './header-chip'
import { ToggleSwitch } from '../ui/ToggleSwitch'

/**
 * The "Look" button in the chat's session strip and its panel (3.1.0, C58).
 * Every change shows at once in the transcript behind the panel, which is
 * why the panel stands at the right edge and leaves the chat readable. The
 * background part needs an open chat; everything else applies to all chats.
 */
export function ChatLookButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Chat look: colours, font, width, background, text size"
        aria-label="Chat look"
        aria-expanded={open}
        data-testid="chat-look-button"
        className={`${HEADER_CHIP} ${open ? 'border-purple-400/50 text-purple-600 dark:text-purple-300' : 'border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500'}`}
      >
        <Palette size={10} />
      </button>
      <AnimatePresence>{open && <ChatLookPanel onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  )
}

const LABEL = 't-micro font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400'
const ROW = 'flex items-center justify-between gap-2 min-h-[26px]'
const TEXT = 't-micro text-gray-700 dark:text-gray-200'
const QUIET = 't-micro text-gray-500 dark:text-gray-400'
const BTN = 'inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-white/10 px-2 py-1 t-micro text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.06] disabled:opacity-40 transition-colors'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 px-3 py-2.5 border-b border-gray-100 dark:border-white/[0.06]">
      <h3 className={LABEL}>{title}</h3>
      {children}
    </section>
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-gray-200 dark:border-white/10 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={'px-2 py-0.5 rounded t-micro transition-colors ' + (value === o.id
            ? 'bg-purple-500/15 text-purple-800 dark:text-purple-200 font-semibold'
            : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** One colour: a swatch that opens the system picker, and a clear button.
 *  When the guard had to move the colour for the current mode, it says so. */
function ColorRow({ label, value, onChange, mode, surface, isSurface = false }: {
  label: string; value: string | null; onChange: (v: string | null) => void; mode: 'light' | 'dark'; surface?: string
  /** A bubble is a surface, laid over the pane as a soft tint; it is not
   *  read as text, so the readability note does not apply to it. */
  isSurface?: boolean
}) {
  const shown = value && !isSurface ? readableOn(value, surface ?? PANE[mode]) : null
  const moved = !!value && !!shown && shown.toLowerCase() !== value.toLowerCase()
  return (
    <div className={ROW}>
      <span className={TEXT}>{label}</span>
      <span className="flex items-center gap-1.5">
        {moved && <span className={QUIET} title={`Shown as ${shown} so it stays readable in ${mode} mode`}>adjusted</span>}
        <label className="relative h-5 w-8 cursor-pointer rounded border border-gray-300 dark:border-white/15 overflow-hidden"
          style={{ background: value ?? 'repeating-linear-gradient(45deg, transparent 0 3px, rgba(127,127,127,.25) 3px 6px)' }}
          title={value ? `${label}: ${value}` : `${label}: app default`}>
          <input
            type="color"
            aria-label={label}
            value={value ?? '#888888'}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>
        <button type="button" onClick={() => onChange(null)} disabled={!value} className="p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30" aria-label={`Reset ${label}`} title="Back to the app's colour">
          <X size={11} />
        </button>
      </span>
    </div>
  )
}

function ChatLookPanel({ onClose }: { onClose: () => void }) {
  useDismissOnEscape(true, onClose)
  const look = useChatLookStore((s) => s.look)
  const setLook = useChatLookStore((s) => s.setLook)
  const replaceLook = useChatLookStore((s) => s.replaceLook)
  const resetLook = useChatLookStore((s) => s.resetLook)
  const zoom = useChatLookStore((s) => s.zoom)
  const setZoom = useChatLookStore((s) => s.setZoom)
  const theme = useSettingsStore((s) => s.settings.theme)
  const mode = theme === 'light' ? 'light' : 'dark'
  const [cssOpen, setCssOpen] = useState(look.customCssOn || !!look.customCss)
  const [note, setNote] = useState<string | null>(null)

  const set = <K extends keyof ChatLook>(k: K) => (v: ChatLook[K]) => setLook({ [k]: v } as Partial<ChatLook>)
  const dropped = useMemo(() => (look.customCss ? sanitizeChatCss(look.customCss).dropped : []), [look.customCss])

  const copyLook = async () => {
    const { customCssOn: _on, ...rest } = look
    void _on
    try {
      await navigator.clipboard.writeText(JSON.stringify({ luChatLook: 1, look: rest }, null, 2))
      setNote('Look copied. Paste it on another computer with "Paste look".')
    } catch { setNote('Could not copy to the clipboard.') }
  }
  const pasteLook = async () => {
    try {
      const text = await navigator.clipboard.readText()
      const parsed: unknown = JSON.parse(text)
      const raw = parsed && typeof parsed === 'object' && 'look' in parsed ? (parsed as { look: unknown }).look : parsed
      // Custom CSS from someone else stays off until switched on here.
      replaceLook({ ...normalizeLook(raw), customCssOn: false })
      setNote('Look pasted. Custom CSS from it is off until you switch it on.')
    } catch { setNote('The clipboard holds no chat look.') }
  }

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50"
      onClick={onClose}
    >
      <motion.div
        initial={{ x: 16, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 16, opacity: 0 }}
        role="dialog"
        aria-label="Chat look"
        data-testid="chat-look-panel"
        className="absolute right-2 top-12 bottom-2 w-[min(340px,calc((100vw-16px)/var(--ui-scale)))] lu-dialog rounded-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-white/[0.06] shrink-0">
          <span className="flex items-center gap-1.5 t-small font-semibold text-gray-800 dark:text-gray-100"><Palette size={13} className="text-purple-500" /> Chat look</span>
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => { resetLook(); setNote('Back to the LU default look.') }} className={BTN} title="Back to the LU default look"><RotateCcw size={10} /> Reset</button>
            <button type="button" onClick={onClose} className="p-1 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10" aria-label="Close"><X size={13} /></button>
          </span>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <Section title="Presets">
            <div className="flex flex-wrap gap-1">
              {LOOK_PRESETS.map((p) => (
                <button key={p.id} type="button" className={BTN} onClick={() => replaceLook({ ...DEFAULT_LOOK, customCss: look.customCss, customCssOn: look.customCssOn, ...p.look })}>
                  {p.label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Text size">
            <div className={ROW}>
              <span className={QUIET}>Ctrl/Cmd + mouse wheel, or Ctrl/Cmd + and -</span>
              <span className="flex items-center gap-1">
                <button type="button" className={BTN} aria-label="Smaller text" disabled={zoom <= ZOOM_MIN} onClick={() => setZoom(zoom - ZOOM_STEP)}><Minus size={10} /></button>
                <button type="button" className={`${BTN} min-w-[52px] justify-center`} title="Reset to 100%" onClick={() => setZoom(1)} data-testid="chat-look-zoom">{Math.round(zoom * 100)}%</button>
                <button type="button" className={BTN} aria-label="Larger text" disabled={zoom >= ZOOM_MAX} onClick={() => setZoom(zoom + ZOOM_STEP)}><Plus size={10} /></button>
              </span>
            </div>
          </Section>

          <Section title="Colours">
            <ColorRow label="Reply text" value={look.modelText} onChange={set('modelText')} mode={mode} />
            <ColorRow label="Your text" value={look.userText} onChange={set('userText')} mode={mode} />
            <ColorRow label="Your bubble" value={look.userBubble} onChange={set('userBubble')} mode={mode} isSurface />
            <ColorRow label="Reply bubble" value={look.modelBubble} onChange={set('modelBubble')} mode={mode} isSurface />
            <p className={QUIET}>Every colour is kept readable (4.5:1) in light and in dark mode.</p>
          </Section>

          <Section title="Highlight">
            <div className={ROW}>
              <span className={TEXT}>"Quoted speech"</span>
              <ToggleSwitch enabled={look.highlightQuotes} onChange={set('highlightQuotes')} ariaLabel="Highlight quoted speech" />
            </div>
            {look.highlightQuotes && <ColorRow label="Quote colour" value={look.quoteText} onChange={set('quoteText')} mode={mode} />}
            <div className={ROW}>
              <span className={TEXT}><em>*Actions*</em></span>
              <ToggleSwitch enabled={look.highlightActions} onChange={set('highlightActions')} ariaLabel="Highlight actions" />
            </div>
            {look.highlightActions && <ColorRow label="Action colour" value={look.actionText} onChange={set('actionText')} mode={mode} />}
          </Section>

          <Section title="Text and layout">
            <div className={ROW}>
              <span className={TEXT}>Font</span>
              <select
                value={look.font}
                onChange={(e) => set('font')(e.target.value as ChatFont)}
                aria-label="Font"
                className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.04] px-1.5 py-0.5 t-micro text-gray-700 dark:text-gray-200"
              >
                <option value="app">App</option>
                <option value="serif">Serif (book)</option>
                <option value="sans">System sans</option>
                <option value="mono">Monospace</option>
                <option value="custom">Installed font...</option>
              </select>
            </div>
            {look.font === 'custom' && (
              <input
                value={look.customFont}
                onChange={(e) => set('customFont')(e.target.value)}
                placeholder="Name of a font on this computer, e.g. Georgia"
                aria-label="Installed font name"
                className="w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 t-micro text-gray-800 dark:text-gray-200 placeholder-gray-400"
              />
            )}
            <div className={ROW}>
              <span className={TEXT}>Line spacing</span>
              <input type="range" min={1.2} max={2.2} step={0.05} value={look.lineHeight} onChange={(e) => set('lineHeight')(Number(e.target.value))} aria-label="Line spacing" className="w-32" />
            </div>
            <div className={ROW}>
              <span className={TEXT}>Width</span>
              <Segmented<ChatWidth> label="Chat width" value={look.width} onChange={set('width')} options={[{ id: 'normal', label: 'Normal' }, { id: 'wide', label: 'Wide' }, { id: 'full', label: 'Full' }]} />
            </div>
            <div className={ROW}>
              <span className={TEXT}>Layout</span>
              <Segmented<ChatLayout> label="Chat layout" value={look.layout} onChange={set('layout')} options={[{ id: 'default', label: 'LU' }, { id: 'bubbles', label: 'Bubbles' }, { id: 'document', label: 'Document' }]} />
            </div>
          </Section>

          <BackgroundSection />

          <section className="px-3 py-2.5 border-b border-gray-100 dark:border-white/[0.06] space-y-1.5">
            <button type="button" onClick={() => setCssOpen((o) => !o)} className={`flex items-center gap-1 ${LABEL}`} aria-expanded={cssOpen}>
              {cssOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Custom CSS (advanced)
            </button>
            {cssOpen && (
              <>
                <div className={ROW}>
                  <span className={TEXT}>Use my CSS</span>
                  <ToggleSwitch enabled={look.customCssOn} onChange={set('customCssOn')} ariaLabel="Use custom CSS" />
                </div>
                <textarea
                  value={look.customCss}
                  onChange={(e) => set('customCss')(e.target.value)}
                  spellCheck={false}
                  rows={7}
                  aria-label="Custom CSS"
                  placeholder={'.lu-msg-model-text { letter-spacing: .01em }\n.lu-quote { font-weight: 600 }\n:scope[data-mode="dark"] .lu-msg-user-bubble { border-radius: 14px }'}
                  className="w-full rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 font-mono t-micro leading-snug text-gray-800 dark:text-gray-200 placeholder-gray-400"
                />
                <p className={QUIET}>
                  Applies to the messages only. No url(), @import, fonts or pictures from the web, no fixed boxes.
                  Hooks: .lu-msg-user-text, .lu-msg-model-text, .lu-msg-user-bubble, .lu-quote, .lu-action, :scope.
                </p>
                {dropped.length > 0 && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/[0.05] px-2 py-1 t-micro text-red-700 dark:text-red-300" data-testid="chat-css-dropped">
                    Not applied: {dropped.slice(0, 5).join(' · ')}{dropped.length > 5 ? ` and ${dropped.length - 5} more` : ''}
                  </div>
                )}
              </>
            )}
          </section>

          <Section title="Share">
            <div className="flex flex-wrap gap-1">
              <button type="button" className={BTN} onClick={() => void copyLook()}><Copy size={10} /> Copy look</button>
              <button type="button" className={BTN} onClick={() => void pasteLook()}><ClipboardPaste size={10} /> Paste look</button>
            </div>
            {note && <p className={QUIET} role="status">{note}</p>}
          </Section>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

function BackgroundSection() {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId))
  const personas = useSettingsStore((s) => s.personas)
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const backgrounds = useChatLookStore((s) => s.backgrounds)
  const setBackground = useChatLookStore((s) => s.setBackground)
  const patchBackground = useChatLookStore((s) => s.patchBackground)
  const removeBackground = useChatLookStore((s) => s.removeBackground)
  const persona = conversation?.personaId ? personas.find((p) => p.id === conversation.personaId) : undefined
  const [target, setTarget] = useState<'chat' | 'persona'>(() => (persona && conversation && !backgrounds[bgKeyForChat(conversation.id)] && backgrounds[bgKeyForPersona(persona.id)] ? 'persona' : 'chat'))
  const [busy, setBusy] = useState<null | 'file' | 'gallery' | 'render'>(null)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [prompt, setPrompt] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!conversation) {
    return (
      <Section title="Background">
        <p className={QUIET}>Open a chat to give it a background picture.</p>
      </Section>
    )
  }

  const key = target === 'persona' && persona ? bgKeyForPersona(persona.id) : bgKeyForChat(conversation.id)
  const bg = backgrounds[key]

  const apply = async (what: 'file' | 'gallery' | 'render', make: () => Promise<string>) => {
    setBusy(what)
    setError(null)
    try {
      const ref = await make()
      setBackground(key, { ref, scrim: bg?.scrim ?? SCRIM_DEFAULT, blur: bg?.blur ?? 0 })
      setPicking(false)
      if (what === 'render') setPrompt(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const startScene = () => {
    const texts = conversation.messages
      .filter((m) => (m.role === 'assistant' || m.role === 'user') && !m.hidden)
      .slice(-4)
      .map((m) => m.content)
    setPrompt(scenePrompt(texts))
    setError(null)
  }

  const openInCreate = () => {
    if (!prompt) return
    const create = useCreateStore.getState()
    create.setIntent('image')
    create.setPrompt(prompt)
    useUIStore.getState().setView('create')
  }

  return (
    <Section title="Background">
      {persona && (
        <div className={ROW}>
          <span className={TEXT}>For</span>
          <Segmented<'chat' | 'persona'> label="Background for" value={target} onChange={setTarget} options={[{ id: 'chat', label: 'This chat' }, { id: 'persona', label: persona.name.slice(0, 18) }]} />
        </div>
      )}
      {target === 'chat' && persona && !bg && backgrounds[bgKeyForPersona(persona.id)] && (
        <p className={QUIET}>This chat shows the picture of {persona.name}. A picture set here wins.</p>
      )}
      <div className="flex flex-wrap gap-1">
        <button type="button" className={BTN} disabled={!!busy} onClick={() => fileRef.current?.click()}><Upload size={10} /> {busy === 'file' ? 'Saving...' : 'From file'}</button>
        <button type="button" className={BTN} disabled={!!busy} onClick={() => setPicking((p) => !p)} aria-expanded={picking}><Images size={10} /> From gallery</button>
        <button type="button" className={BTN} disabled={!!busy} onClick={startScene} data-testid="chat-bg-scene"><Sparkles size={10} /> From this scene</button>
        {bg && <button type="button" className={`${BTN} hover:text-red-500`} disabled={!!busy} onClick={() => removeBackground(key)}><Trash2 size={10} /> Remove</button>}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void apply('file', () => storeBackground(f))
        }}
      />
      {picking && <GalleryPicker disabled={!!busy} onPick={(blob) => apply('gallery', () => blob().then(storeBackground))} />}
      {prompt !== null && (
        <div className="space-y-1 rounded-md border border-gray-200 dark:border-white/10 p-2">
          <p className={QUIET}>A picture from the latest messages. Edit the description, then make it.</p>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} aria-label="Background description"
            className="w-full rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1 t-micro text-gray-800 dark:text-gray-200" />
          <div className="flex flex-wrap items-center gap-1">
            {appMode === 'cloud' ? (
              <>
                <button type="button" className={BTN} onClick={openInCreate}><Sparkles size={10} /> Open in Create</button>
                <span className={QUIET}>Create shows the price first. Then pick the picture here under From gallery.</span>
              </>
            ) : busy === 'render' ? (
              <button type="button" className={BTN} onClick={() => void cancelSceneBackground(conversation.id)}><Square size={10} /> Stop</button>
            ) : (
              <button type="button" className={BTN} disabled={!!busy || !prompt.trim()} onClick={() => void apply('render', () => renderSceneBackground(prompt, conversation.id))} data-testid="chat-bg-render">
                <Sparkles size={10} /> Make picture
              </button>
            )}
            {busy !== 'render' && <button type="button" className={BTN} onClick={() => setPrompt(null)}>Cancel</button>}
            {busy === 'render' && <span className={QUIET}>Rendering with your local image model...</span>}
          </div>
        </div>
      )}
      {bg && (
        <>
          <div className={ROW}>
            <span className={TEXT}>Readability</span>
            <input type="range" min={SCRIM_MIN} max={0.95} step={0.01} value={bg.scrim} onChange={(e) => patchBackground(key, { scrim: Number(e.target.value) })} aria-label="Background dimming" className="w-32" />
          </div>
          <div className={ROW}>
            <span className={TEXT}>Blur</span>
            <input type="range" min={0} max={16} step={1} value={bg.blur} onChange={(e) => patchBackground(key, { blur: Number(e.target.value) })} aria-label="Background blur" className="w-32" />
          </div>
        </>
      )}
      {error && <p className="t-micro text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </Section>
  )
}

function GalleryPicker({ onPick, disabled }: { onPick: (blob: () => Promise<Blob>) => void; disabled: boolean }) {
  const gallery = useCreateStore((s) => s.gallery)
  const images = gallery.filter((g) => g.type === 'image' && !g.unavailable).slice(0, 24)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const ids = images.map((i) => i.id).join('|')
  useEffect(() => {
    let alive = true
    // Loaded on demand: the gallery helpers pull the Create and cloud code.
    void import('../create/experimental/galleryUrl').then(({ galleryItemUrl }) => {
      if (alive) setUrls(Object.fromEntries(images.map((i) => [i.id, galleryItemUrl(i)])))
    })
    return () => { alive = false }
    // `ids` stands for the list; the items themselves are new objects per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])
  if (images.length === 0) return <p className={QUIET}>No pictures in the Create gallery yet.</p>
  return (
    <div className="grid grid-cols-4 gap-1 max-h-40 overflow-y-auto scrollbar-thin" data-testid="chat-bg-gallery">
      {images.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={disabled}
          title={item.prompt.slice(0, 120)}
          onClick={() => onPick(async () => (await import('../create/experimental/galleryUrl')).fetchGalleryItemBlob(item))}
          className="aspect-square rounded overflow-hidden border border-gray-200 dark:border-white/10 hover:border-purple-400 disabled:opacity-40"
        >
          {urls[item.id] && <img src={urls[item.id]} alt="" loading="lazy" className="h-full w-full object-cover" />}
        </button>
      ))}
    </div>
  )
}
