import type { ReactNode } from 'react'

/**
 * Der Zeilenschalter der Einstellungen. Er stand als lokale Funktion in
 * `SettingsPage.tsx` und wird jetzt von zwei Dateien gebraucht — der
 * ausgezogene Abschnitt `SpeechSettings.tsx` benutzt ihn viermal. Ein
 * Import zurueck in `SettingsPage.tsx` waere ein Zyklus gewesen, eine
 * zweite Kopie waere die naechste Divergenz. Also hierhin, einmal.
 */
export function InlineToggle({ label, enabled, onChange, icon }: { label: string; enabled: boolean; onChange: () => void; icon?: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[0.7rem] text-gray-700 dark:text-gray-400">{label}</span>
      </div>
      <button
        onClick={onChange}
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        className={`relative w-7 h-3.5 rounded-full transition-colors ${enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-3.5' : ''}`} />
      </button>
    </div>
  )
}
