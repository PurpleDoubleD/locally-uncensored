// Settings → Agent → Watchers: the notification of the system when a watcher
// ran. Three rows and nothing else (David, 14.11.2026): on or off, the sound,
// and whether a result is worth a notification or only an error.
import { InlineToggle } from './InlineToggle'
import { useWatcherSettingsStore, type WatcherNotifyOn } from '../../stores/watcherStore'

const CHOICES: { value: WatcherNotifyOn; label: string }[] = [
  { value: 'all', label: 'Results and errors' },
  { value: 'errors', label: 'Errors only' },
]

export function WatcherSettings() {
  const { notify, sound, notifyOn, update } = useWatcherSettingsStore()
  return (
    <div className="space-y-1">
      <p className="t-micro text-gray-500 leading-relaxed pb-1">
        A notification of the system when a watcher has run, also with the window closed. Watchers are made in the chat
        (&ldquo;at 18:00 check …&rdquo;) and run as long as LU runs.
      </p>
      <InlineToggle label="Notifications" enabled={notify} onChange={() => update({ notify: !notify })} />
      <InlineToggle label="Sound" enabled={sound && notify} onChange={() => update({ sound: !sound })} />
      <div className="flex items-center justify-between py-0.5">
        <span className="t-control font-normal text-gray-700 dark:text-gray-400">Notify on</span>
        <div className="flex items-center gap-3" role="radiogroup" aria-label="Notify on">
          {CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={notifyOn === c.value}
              disabled={!notify}
              onClick={() => update({ notifyOn: c.value })}
              className={`t-micro transition-colors disabled:opacity-40 ${notifyOn === c.value ? 'text-gray-900 dark:text-gray-100 underline underline-offset-4' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
