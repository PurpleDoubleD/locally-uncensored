import { useState } from 'react'
import { Plus, Trash2, Pencil } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { PersonaCard } from './PersonaCard'
import { SystemPromptEditor } from './SystemPromptEditor'

export function PersonaPanel() {
  const { personas, activePersonaId, setActivePersona, removePersona } = useSettingsStore()
  const personasEnabled = useSettingsStore((s) => s.settings.personasEnabled)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [showEditor, setShowEditor] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const editingPersona = editingId ? personas.find((p) => p.id === editingId) : undefined

  return (
    <div className="w-full max-w-2xl">
      {/* Master switch — controls whether any persona system prompt is
          applied at all. When off, every new chat runs the raw model. The
          picker below stays interactive so the user can pre-select a persona
          for the moment they flip the switch on. (Ported from uselu web.) */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-100 dark:border-white/[0.04]">
        <div className="flex flex-col">
          <span className="text-[0.7rem] font-medium text-gray-800 dark:text-gray-200">
            Use personas
          </span>
          <span className="text-[0.55rem] text-gray-500 dark:text-gray-500">
            {personasEnabled
              ? 'Active persona is applied to new chats.'
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
              isActive={persona.id === activePersonaId}
              onClick={() => setActivePersona(persona.id)}
            />
            {!persona.isBuiltIn && (
              <div className="absolute -top-1 -right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
      </div>

      {/* Edit mode (GitHub #55) takes precedence over create mode. The `key`
          remounts the editor per persona so its seeded fields refresh. */}
      {editingPersona ? (
        <SystemPromptEditor
          key={editingPersona.id}
          editingId={editingPersona.id}
          initialName={editingPersona.name}
          initialPrompt={editingPersona.systemPrompt}
          onDone={() => setEditingId(null)}
        />
      ) : showEditor ? (
        <SystemPromptEditor onDone={() => setShowEditor(false)} />
      ) : null}
    </div>
  )
}
