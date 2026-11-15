/**
 * Settings → Agent → Allowed commands (CA K4).
 *
 * The commands the user said "always allow here" for, per folder, with a way
 * to take each one back. Nothing is added from this screen: a rule only comes
 * from the user's own click on a waiting command.
 */
import { X } from 'lucide-react'
import { useCommandRulesStore } from '../../stores/commandRulesStore'

function scopeLabel(scope: string): string {
  return scope.startsWith('chat:') ? 'One chat’s own folder' : scope
}

export function CommandRulesSettings() {
  const rules = useCommandRulesStore((s) => s.rules)
  const remove = useCommandRulesStore((s) => s.remove)
  const scopes = Object.keys(rules).filter((k) => rules[k]?.length)

  return (
    <div className="space-y-2" data-testid="command-rules">
      <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed">
        Commands that run without asking, because you chose “Always allow … here” on one of them. They only apply in that folder, every part of a combined command must be on the list, and dangerous commands stay blocked whatever this list says.
      </div>
      {scopes.length === 0 ? (
        <div className="t-micro text-gray-500">None yet.</div>
      ) : (
        scopes.map((scope) => (
          <div key={scope} className="rounded border border-gray-200 dark:border-white/10 p-2">
            <div className="t-micro text-gray-600 dark:text-gray-400 truncate" title={scope}>{scopeLabel(scope)}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {rules[scope].map((rule) => (
                <span key={rule} className="inline-flex items-center gap-1 rounded bg-gray-100 dark:bg-white/[0.06] pl-2 pr-1 py-0.5">
                  <code className="font-mono t-micro text-gray-800 dark:text-gray-200">{rule}</code>
                  <button
                    type="button"
                    onClick={() => remove(scope, rule)}
                    aria-label={`Remove ${rule}`}
                    className="p-0.5 rounded text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
