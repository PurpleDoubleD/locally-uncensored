import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { GlowButton } from '../ui/GlowButton'
import { useSettingsStore } from '../../stores/settingsStore'

export function SystemPromptEditor() {
  const { addPersona } = useSettingsStore()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return
    addPersona({
      id: uuid(),
      name: name.trim(),
      icon: 'User',
      systemPrompt: prompt.trim(),
      isBuiltIn: false,
    })
    setName('')
    setPrompt('')
  }

  return (
    <div className="space-y-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Persona name..."
        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm"
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="System prompt..."
        rows={4}
        className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-white/20 text-sm resize-none"
      />
      <GlowButton onClick={handleSave} disabled={!name.trim() || !prompt.trim()} className="w-full">
        Save Persona
      </GlowButton>
    </div>
  )
}
