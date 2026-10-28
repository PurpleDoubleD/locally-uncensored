import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Plus, Trash2, Pencil, Upload, Download } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { useSettingsStore } from '../../stores/settingsStore'
import { CardError, MAX_CARD_FILE_BYTES, isPng, parseCardFile, personaFromCard } from '../../lib/character-card'
import { cardImageDataUrl, saveCardExport } from '../../lib/character-card-files'
import type { Persona } from '../../types/settings'
import { Hinweis } from '../ui/Hinweis'
import { PersonaCard } from './PersonaCard'
import { SystemPromptEditor } from './SystemPromptEditor'

export function PersonaPanel() {
  const { personas, activePersonaId, setActivePersona, removePersona, addPersona } = useSettingsStore()
  const personasEnabled = useSettingsStore((s) => s.settings.personasEnabled)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [showEditor, setShowEditor] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const editingPersona = editingId ? personas.find((p) => p.id === editingId) : undefined
  const activePersona = personas.find((p) => p.id === activePersonaId)
  const cardFileRef = useRef<HTMLInputElement>(null)
  const [cardMsg, setCardMsg] = useState<{ text: string; error: boolean } | null>(null)

  // Character cards (3.0.7): a PNG or JSON card becomes a custom persona.
  // Read in the WebView through a plain file input, like the profile picture.
  const onCardPicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    try {
      if (file.size > MAX_CARD_FILE_BYTES) throw new CardError('This file is larger than 20 MB.')
      const bytes = new Uint8Array(await file.arrayBuffer())
      const parsed = await parseCardFile(bytes)
      const image = isPng(bytes) ? await cardImageDataUrl(bytes) : undefined
      const persona = personaFromCard(parsed, uuid(), image)
      addPersona(persona)
      setActivePersona(persona.id)
      setCardMsg({
        text: personasEnabled
          ? `Imported ${persona.name}. New chats start with this character.`
          : `Imported ${persona.name}. Switch on personas to chat with this character.`,
        error: false,
      })
    } catch (err) {
      setCardMsg({
        text: err instanceof CardError ? err.message : 'Could not read that character card.',
        error: true,
      })
    }
  }

  const onExport = async (persona: Persona) => {
    try {
      const res = await saveCardExport(persona)
      if (res.status === 'saved') setCardMsg({ text: `Saved to ${res.path}.`, error: false })
      else if (res.status === 'downloaded') setCardMsg({ text: 'Downloaded the character card.', error: false })
    } catch {
      setCardMsg({ text: 'Could not save the character card.', error: true })
    }
  }

  return (
    <div className="w-full max-w-2xl">
      {/* Master switch — controls whether any persona system prompt is
          applied at all. When off, every new chat runs the raw model. The
          picker below stays interactive so the user can pre-select a persona
          for the moment they flip the switch on. (Ported from the web app.)
          The line under the switch names the per-chat toggle on purpose:
          chatStore creates every new conversation with `personaEnabled:
          false`, so a globally chosen persona is prepared, never applied
          on its own. Two testers in a row read the old wording as a
          promise and filed the missing persona as a bug (T13d). */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-100 dark:border-white/[0.04]">
        <div className="flex flex-col">
          <span className="text-[0.7rem] font-medium text-gray-800 dark:text-gray-200">
            Use personas
          </span>
          <span className="text-[0.55rem] text-gray-500 dark:text-gray-500">
            {personasEnabled
              ? 'Active persona is available in every chat. Switch it on per chat in the Plugins menu.'
              : 'Off: raw model, no persona prompt.'}
          </span>
        </div>
        <button
          onClick={() => updateSettings({ personasEnabled: !personasEnabled })}
          className={
            'relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors ' +
            (personasEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-white/10')
          }
          aria-pressed={personasEnabled}
          aria-label="Toggle personas master switch"
        >
          <span
            className={
              'pointer-events-none absolute top-0.5 h-3 w-3 transform rounded-full bg-white shadow transition-transform ' +
              (personasEnabled ? 'translate-x-3.5' : 'translate-x-0.5')
            }
          />
        </button>
      </div>

      <div
        className={
          'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 mb-4 max-h-[300px] overflow-y-auto scrollbar-thin pr-1 transition-opacity ' +
          (personasEnabled ? '' : 'opacity-50 pointer-events-none')
        }
      >
        {personas.map((persona) => (
          <div key={persona.id} className="relative group">
            <PersonaCard
              name={persona.name}
              icon={persona.icon}
              imageDataUrl={persona.imageDataUrl}
              isActive={persona.id === activePersonaId}
              onClick={() => setActivePersona(persona.id)}
            />
            {!persona.isBuiltIn && (
              <div className="absolute -top-1 -right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {persona.card && (
                  <button
                    onClick={() => void onExport(persona)}
                    title="Export as character card"
                    className="w-5 h-5 rounded-full bg-gray-600/90 text-white flex items-center justify-center hover:bg-gray-500"
                  >
                    <Download size={10} />
                  </button>
                )}
                <button
                  onClick={() => { setEditingId(persona.id); setShowEditor(false) }}
                  title="Edit persona"
                  className="w-5 h-5 rounded-full bg-gray-600/90 text-white flex items-center justify-center hover:bg-gray-500"
                >
                  <Pencil size={10} />
                </button>
                <button
                  onClick={() => { removePersona(persona.id); if (editingId === persona.id) setEditingId(null) }}
                  title="Delete persona"
                  className="w-5 h-5 rounded-full bg-red-500/80 text-white flex items-center justify-center hover:bg-red-500"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            )}
          </div>
        ))}
        <button
          onClick={() => { setShowEditor(!showEditor); setEditingId(null) }}
          className="flex flex-col items-center gap-2 p-4 rounded-xl bg-gray-50 dark:bg-white/[0.02] border border-gray-300 dark:border-white/10 hover:border-gray-400 dark:hover:border-white/15 transition-colors cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-gray-100 dark:bg-white/5">
            <Plus size={20} className="text-gray-500" />
          </div>
          <span className="text-xs text-gray-500">Custom</span>
        </button>
        <button
          onClick={() => cardFileRef.current?.click()}
          title="Import a character card (PNG or JSON)"
          className="flex flex-col items-center gap-2 p-4 rounded-xl bg-gray-50 dark:bg-white/[0.02] border border-gray-300 dark:border-white/10 hover:border-gray-400 dark:hover:border-white/15 transition-colors cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-gray-100 dark:bg-white/5">
            <Upload size={20} className="text-gray-500" />
          </div>
          <span className="text-xs text-gray-500 text-center leading-tight">Import card</span>
        </button>
        <input
          ref={cardFileRef}
          type="file"
          accept=".png,.json,image/png,application/json"
          onChange={(e) => void onCardPicked(e)}
          className="hidden"
          data-testid="card-file-input"
        />
      </div>

      {cardMsg && (
        <div className="mb-3" data-testid="card-message">
          <Hinweis ton={cardMsg.error ? 'fehler' : 'ruhig'}>{cardMsg.text}</Hinweis>
        </div>
      )}

      {/* Creator notes of the selected character card: for the reader only,
          never part of the prompt. */}
      {activePersona?.card?.creatorNotes?.trim() && !editingPersona && !showEditor && (
        <div className="mb-3 rounded-lg border border-gray-200 dark:border-white/[0.06] p-2" data-testid="card-creator-notes">
          <div className="text-[0.6rem] font-medium text-gray-700 dark:text-gray-300 mb-1">
            Creator notes for {activePersona.name}
          </div>
          <div className="text-[0.6rem] text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-words max-h-32 overflow-y-auto scrollbar-thin">
            {activePersona.card.creatorNotes.trim()}
          </div>
        </div>
      )}

      {/* Edit mode (GitHub #55) takes precedence over create mode. The `key`
          remounts the editor per persona so its seeded fields refresh. */}
      {editingPersona ? (
        <SystemPromptEditor
          key={editingPersona.id}
          editingId={editingPersona.id}
          initialName={editingPersona.name}
          initialPrompt={editingPersona.systemPrompt}
          initialSampling={editingPersona.sampling}
          initialNote={editingPersona.note}
          initialNoteDepth={editingPersona.noteDepth}
          initialCustomParams={editingPersona.customParams}
          onDone={() => setEditingId(null)}
        />
      ) : showEditor ? (
        <SystemPromptEditor onDone={() => setShowEditor(false)} />
      ) : null}
    </div>
  )
}
