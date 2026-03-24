import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { PersonaCard } from './PersonaCard'
import { SystemPromptEditor } from './SystemPromptEditor'

export function PersonaPanel() {
  const { personas, activePersonaId, setActivePersona, removePersona } = useSettingsStore()
  const [showEditor, setShowEditor] = useState(false)

  return (
    <div className="w-full max-w-2xl">
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 mb-4 max-h-[300px] overflow-y-auto scrollbar-thin pr-1">
        {personas.map((persona) => (
          <div key={persona.id} className="relative group">
            <PersonaCard
              name={persona.name}
              icon={persona.icon}
              isActive={persona.id === activePersonaId}
              onClick={() => setActivePersona(persona.id)}
            />
            {!persona.isBuiltIn && (
              <button
                onClick={() => removePersona(persona.id)}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        ))}
        <button
          onClick={() => setShowEditor(!showEditor)}
          className="flex flex-col items-center gap-2 p-4 rounded-xl border border-dashed border-white/10 hover:border-white/15 transition-all cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-white/5">
            <Plus size={20} className="text-gray-500" />
          </div>
          <span className="text-xs text-gray-500">Custom</span>
        </button>
      </div>

      {showEditor && <SystemPromptEditor />}
    </div>
  )
}
