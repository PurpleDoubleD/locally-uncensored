/**
 * skill_view and skill_save (C59 A7). Store: stores/skillStore.ts.
 *
 * The prompt lists the approved skills by name and one line each; the body
 * comes in with skill_view when the agent needs it (progressive disclosure,
 * as agentskills.io and Hermes do it), so twenty skills cost ~500 tokens,
 * not twenty documents.
 *
 * skill_save never saves. It files a proposal; the user reads the whole
 * text in Settings → Agent → Skills and saves or discards it. That holds in
 * Bypass too: there is no approval to auto-accept, the tool has no way in.
 */
import type { MCPToolDefinition } from '../api/mcp/types'
import { looksLikeSecret } from './memory-tool'
import { secretAccessOf } from './secret-paths'
import { SKILLS_IN_PROMPT, SKILL_BODY_MAX, SKILL_NAME, normaliseSkillName, type Skill } from '../stores/skillStore'

export const SKILL_VIEW = 'skill_view'
export const SKILL_SAVE = 'skill_save'

export const SKILL_VIEW_DEF: MCPToolDefinition = {
  name: SKILL_VIEW,
  description: 'Read an approved skill (listed under Skills) before you follow it.',
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'From the list.' } }, required: ['name'] },
  category: 'system',
  source: 'builtin',
}

export const SKILL_SAVE_DEF: MCPToolDefinition = {
  name: SKILL_SAVE,
  description: 'Propose a reusable procedure after a hard or corrected task. Not saved until the user approves it. Body sections: When to use, Procedure, Pitfalls, Verification. No secrets.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'lower-case-with-dashes' },
      description: { type: 'string', description: 'One line.' },
      body: { type: 'string', description: 'Markdown, at most 8 KB.' },
    },
    required: ['name', 'description', 'body'],
  },
  category: 'system',
  source: 'builtin',
}

export interface SkillPort {
  get: (name: string) => Skill | undefined
  propose: (s: { name: string; description: string; body: string; fromConversation?: string }) => string | null
  names: () => string[]
}

export function runSkillView(args: Record<string, unknown>, port: SkillPort): string {
  const name = normaliseSkillName(String(args.name ?? ''))
  if (!name) return 'Error: skill_view needs the skill `name` from the list.'
  const skill = port.get(name)
  if (!skill) {
    const known = port.names()
    return `Error: no approved skill "${name}".${known.length ? ` Approved: ${known.join(', ')}.` : ' There are no approved skills.'}`
  }
  return `Skill "${skill.name}" (approved by the user): ${skill.description}\n\n${skill.body}`
}

export function runSkillSave(args: Record<string, unknown>, port: SkillPort, convId?: string): { text: string; notice?: string } {
  const name = normaliseSkillName(String(args.name ?? ''))
  const description = String(args.description ?? '').trim()
  const body = String(args.body ?? '').trim()
  if (!SKILL_NAME.test(name)) return { text: 'Error: name must be 2–48 characters, lower case letters, digits and dashes.' }
  if (!description || !body) return { text: 'Error: skill_save needs name, description and body.' }
  if (body.length > SKILL_BODY_MAX) return { text: `Error: the body is at most ${SKILL_BODY_MAX} bytes. Keep the procedure, not examples.` }
  const all = `${description}\n${body}`
  if (looksLikeSecret(all) || secretAccessOf('skill_save', { command: all })) {
    return { text: 'Error: Refused: the proposal contains something that looks like a secret or a secret file path. Nothing was proposed.' }
  }
  const saved = port.propose({ name, description, body, ...(convId ? { fromConversation: convId } : {}) })
  if (!saved) return { text: 'Error: the proposal could not be filed.' }
  return {
    text: `Proposed skill "${saved}". It is not active: the user reviews it in Settings → Agent → Skills and decides. Tell the user in one sentence that you proposed it and why.`,
    notice: `📘 Skill proposed: ${saved}. Review it in Settings → Agent → Skills; it is not active until you save it.`,
  }
}

/** The prompt section: approved, enabled skills, name and one line each. Empty without skills. */
export function renderSkillsSection(skills: ReadonlyArray<Pick<Skill, 'name' | 'description'>>): string {
  if (!skills.length) return ''
  const list = skills.slice(0, SKILLS_IN_PROMPT).map((s) => `- ${s.name}: ${s.description.slice(0, 100)}`)
  return `\n\nSkills the user approved. When one fits the task, read it with skill_view first and follow it:\n${list.join('\n')}`
}

/**
 * The tool list of a step with the skill tools added: skill_view when the
 * user has approved skills, skill_save when the run may propose (the full
 * profile: cloud and big models; small ones reach it via tool_search), and
 * memory in the full profile, where it costs little and the run may be
 * asked to save before compaction (E6).
 * Only tools the catalog of this run holds (permissions, read-only turns).
 */
export function withSkillTools<T extends { name: string }>(defs: T[], catalog: readonly T[], o: { skills: boolean; propose: boolean; memory?: boolean }): T[] {
  const add = [...(o.skills ? [SKILL_VIEW] : []), ...(o.propose ? [SKILL_SAVE] : []), ...(o.memory ? ['memory'] : [])]
    .filter((n) => !defs.some((d) => d.name === n))
    .map((n) => catalog.find((t) => t.name === n))
    .filter((t): t is T => !!t)
  return add.length ? [...defs, ...add] : defs
}

/** One line for the prompt: when to use memory and skill_save. */
export const MEMORY_SKILL_PROMPT_LINE =
  'When the user asks you to remember something, or corrects how you should work, keep it with the memory tool and say so. After a task that was hard or that the user corrected, you may propose a reusable procedure with skill_save; it only takes effect after the user approves it.'
