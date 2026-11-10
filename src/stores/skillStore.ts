/**
 * Skills (C59 A7): short procedures the agent can look up by name, in the
 * SKILL.md shape of agentskills.io (name, description, then sections like
 * When to use / Procedure / Pitfalls / Verification).
 *
 * Local only, nothing from the net (E8). Two lists, on purpose:
 * - `skills`: what the user approved. Only these reach a prompt.
 * - `proposals`: what an agent suggested (skill_save) or a file import
 *   brought in. A proposal does nothing until the user saves it in
 *   Settings → Agent → Skills, where the whole text is shown. No tool and no
 *   model output can move a proposal into `skills`; the only way is
 *   `approveProposal`, which only the settings UI calls.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

export interface Skill {
  name: string
  description: string
  body: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  source: 'agent' | 'import' | 'user'
  /** Proposals only: the conversation the agent proposed it in. */
  fromConversation?: string
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,47}$/
export const SKILL_DESCRIPTION_MAX = 160
export const SKILL_BODY_MAX = 8 * 1024
/** How many skills the prompt lists at most. */
export const SKILLS_IN_PROMPT = 30

export function normaliseSkillName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 48)
}

/** `---\nname: x\ndescription: y\n---\nbody`. Null when the frontmatter is missing or bad. */
export function parseSkillMd(text: string): { name: string; description: string; body: string } | null {
  const m = text.replace(/^\uFEFF/, '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) return null
  const field = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1].trim().replace(/^["']|["']$/g, '') ?? ''
  const name = normaliseSkillName(field('name'))
  const description = field('description')
  const body = m[2].trim()
  if (!SKILL_NAME.test(name) || !description || !body) return null
  return { name, description: description.slice(0, SKILL_DESCRIPTION_MAX), body: body.slice(0, SKILL_BODY_MAX) }
}

export function toSkillMd(s: Pick<Skill, 'name' | 'description' | 'body'>): string {
  return `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body.trim()}\n`
}

interface SkillInput { name: string; description: string; body: string; status?: 'active' | 'proposed'; source?: Skill['source']; fromConversation?: string }

interface SkillState {
  skills: Skill[]
  proposals: Skill[]
  /** Settings and the bench. `status: 'proposed'` (default for agent and import) lands in proposals. */
  addSkill: (input: SkillInput) => string | null
  approveProposal: (name: string) => boolean
  discardProposal: (name: string) => void
  setEnabled: (name: string, enabled: boolean) => void
  removeSkill: (name: string) => void
  getSkill: (name: string) => Skill | undefined
  activeSkills: () => Skill[]
}

export const useSkillStore = create<SkillState>()(
  persist(
    (set, get) => ({
      skills: [],
      proposals: [],

      addSkill: (input) => {
        const name = normaliseSkillName(input.name)
        const description = input.description.trim().slice(0, SKILL_DESCRIPTION_MAX)
        const body = input.body.trim().slice(0, SKILL_BODY_MAX)
        if (!SKILL_NAME.test(name) || !description || !body) return null
        const now = Date.now()
        const status = input.status ?? (input.source === 'user' ? 'active' : 'proposed')
        const skill: Skill = {
          name, description, body, enabled: true, createdAt: now, updatedAt: now,
          source: input.source ?? 'user',
          ...(input.fromConversation ? { fromConversation: input.fromConversation } : {}),
        }
        if (status === 'active') {
          set((st) => ({ skills: [...st.skills.filter((s) => s.name !== name), skill] }))
        } else {
          set((st) => ({ proposals: [...st.proposals.filter((s) => s.name !== name), skill] }))
        }
        return name
      },

      approveProposal: (name) => {
        const p = get().proposals.find((s) => s.name === name)
        if (!p) return false
        const now = Date.now()
        set((st) => ({
          proposals: st.proposals.filter((s) => s.name !== name),
          skills: [...st.skills.filter((s) => s.name !== name), { ...p, enabled: true, updatedAt: now }],
        }))
        return true
      },

      discardProposal: (name) => set((st) => ({ proposals: st.proposals.filter((s) => s.name !== name) })),
      setEnabled: (name, enabled) => set((st) => ({ skills: st.skills.map((s) => (s.name === name ? { ...s, enabled, updatedAt: Date.now() } : s)) })),
      removeSkill: (name) => set((st) => ({ skills: st.skills.filter((s) => s.name !== name) })),
      getSkill: (name) => get().skills.find((s) => s.name === normaliseSkillName(name) && s.enabled),
      activeSkills: () => get().skills.filter((s) => s.enabled),
    }),
    { name: 'lu-skills', storage: safeJSONStorage() },
  ),
)
