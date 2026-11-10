/**
 * Settings → Agent → Skills (C59 A7).
 *
 * Saved skills: on/off, show, delete. Proposals (from an agent's skill_save
 * or a file import): the whole text, then Save or Discard. This screen is the
 * only place a proposal becomes a skill (stores/skillStore approveProposal).
 * Import reads one local .md file; nothing comes from the net.
 */
import { useRef, useState } from 'react'
import { useSkillStore, parseSkillMd, toSkillMd, type Skill } from '../../stores/skillStore'
import { InlineToggle } from './InlineToggle'

function SkillText({ skill }: { skill: Skill }) {
  return (
    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-100 dark:bg-white/5 p-2 t-micro text-gray-700 dark:text-gray-300">
      {toSkillMd(skill)}
    </pre>
  )
}

export function SkillsSettings() {
  const skills = useSkillStore((s) => s.skills)
  const proposals = useSkillStore((s) => s.proposals)
  const { approveProposal, discardProposal, setEnabled, removeSkill, addSkill } = useSkillStore.getState()
  const [open, setOpen] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onImport = async (file: File | undefined) => {
    setImportError(null)
    if (!file) return
    if (file.size > 16 * 1024) { setImportError('That file is larger than 16 KB. A skill is a short procedure.'); return }
    const parsed = parseSkillMd(await file.text())
    if (!parsed) { setImportError('Not a SKILL.md: it needs a header with name and description between --- lines, then the text.'); return }
    // An import is a proposal like any other: read it below, then save.
    addSkill({ ...parsed, status: 'proposed', source: 'import' })
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="space-y-2">
      <div className="t-micro text-gray-500 dark:text-gray-500 leading-relaxed">
        Short procedures the agent reads by name when a task fits. Only saved skills reach the agent. An agent can only propose one; you read it here and decide.
      </div>

      {proposals.length > 0 && (
        <div className="space-y-2">
          <div className="t-micro font-medium text-purple-700 dark:text-purple-300">Proposed ({proposals.length})</div>
          {proposals.map((p) => (
            <div key={p.name} className="rounded border border-purple-300/60 dark:border-purple-500/30 p-2">
              <div className="t-micro text-gray-800 dark:text-gray-200">
                <span className="font-medium">{p.name}</span>
                <span className="text-gray-500"> · {p.source === 'import' ? 'from a file' : 'proposed by the agent'}</span>
              </div>
              <SkillText skill={p} />
              <div className="mt-1 flex gap-2">
                <button type="button" className="t-micro rounded bg-green-600 px-2 py-0.5 text-white" onClick={() => approveProposal(p.name)}>
                  Save skill
                </button>
                <button type="button" className="t-micro rounded border border-gray-300 dark:border-white/15 px-2 py-0.5" onClick={() => discardProposal(p.name)}>
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {skills.length === 0
        ? <div className="t-micro text-gray-500">No saved skills yet.</div>
        : skills.map((s) => (
          <div key={s.name} className="rounded border border-gray-200 dark:border-white/10 p-2">
            <InlineToggle label={s.name} enabled={s.enabled} onChange={() => setEnabled(s.name, !s.enabled)} />
            <div className="t-micro text-gray-500 dark:text-gray-500">{s.description}</div>
            <div className="mt-1 flex gap-3">
              <button type="button" className="t-micro underline text-gray-600 dark:text-gray-400" onClick={() => setOpen(open === s.name ? null : s.name)}>
                {open === s.name ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="t-micro underline text-red-600 dark:text-red-400" onClick={() => removeSkill(s.name)}>
                Delete
              </button>
            </div>
            {open === s.name && <SkillText skill={s} />}
          </div>
        ))}

      <div>
        <label className="t-micro text-gray-700 dark:text-gray-400">
          Import a SKILL.md from this computer
          <input ref={fileRef} type="file" accept=".md,text/markdown" className="ml-2 t-micro" onChange={(e) => void onImport(e.target.files?.[0])} />
        </label>
        {importError && <div className="t-micro text-red-600 dark:text-red-400">{importError}</div>}
      </div>
    </div>
  )
}
