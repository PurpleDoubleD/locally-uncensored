/**
 * Coding-agent permission modes (plan 2.6.6, C1).
 *
 * Three user-visible presets sit OVER the knobs that already exist
 * (confirm gate, stage mode, review / read-only chain), so the three
 * overlapping systems get ONE operating logic instead of a fourth:
 *
 *   Ask     confirm every arbitrary-exec tool, stage file_write / file_edit
 *   Bypass  local asking off, staging off, the CLOUD shell gate stays
 *   Plan    the read-only chain armed for the whole conversation, plus a
 *           dedicated plan system prompt (see codex-plan-prompt.ts)
 *
 * BINDING (plan C1): a preset NEVER writes the global settings. The mode is
 * resolved per send inside useCodex and turned into effective knobs here.
 * useAgentChat and every other conversation keep reading the settings
 * unchanged, so a Bypass in conversation X cannot flip conversation Y or the
 * Agent surface (codexShellGate is consumed by BOTH loops since G15a).
 *
 * Internally a mode is a ruleset {pattern -> ask | allow | deny}, the opencode
 * schema as the model (R3). The UI only ever shows the three presets; bash
 * globs like "git push*" are a later expansion of the same shape.
 */

import { MUTATING_TOOLS } from './mutating-tools'
import { codexConfirmEnabled } from '../hooks/codexShellGate'

export type CodexMode = 'ask' | 'bypass' | 'plan'

export const CODEX_MODES: readonly CodexMode[] = ['ask', 'bypass', 'plan'] as const

/** English labels, exactly as the plan specifies them for the dropdown. */
export const CODEX_MODE_LABELS: Record<CodexMode, string> = {
  ask: 'Ask permissions',
  bypass: 'Bypass permissions',
  plan: 'Plan mode',
}

/** One word, for the "Approve and run (Ask)" button and the composer trigger. */
export const CODEX_MODE_SHORT: Record<CodexMode, string> = {
  ask: 'Ask',
  bypass: 'Bypass',
  plan: 'Plan',
}

export const CODEX_MODE_DESCRIPTIONS: Record<CodexMode, string> = {
  ask: 'Confirm commands, review edits before they land',
  bypass: 'Run without asking. Commands and edits land as they come',
  plan: 'Read only. Writes a plan, then waits for approval',
}

export function isCodexMode(v: unknown): v is CodexMode {
  return v === 'ask' || v === 'bypass' || v === 'plan'
}

/**
 * The mode this conversation runs under: its own pick wins, otherwise the
 * global default from settings, otherwise 'ask'. Nothing else is consulted.
 */
export function resolveCodexMode(
  conversationMode: unknown,
  defaultMode: unknown,
): CodexMode {
  if (isCodexMode(conversationMode)) return conversationMode
  if (isCodexMode(defaultMode)) return defaultMode
  return 'ask'
}

export type PermissionDecision = 'ask' | 'allow' | 'deny'

export interface CodexModeRule {
  /** Tool-name pattern. '*' matches anything, a trailing '*' is a prefix. */
  pattern: string
  decision: PermissionDecision
}

/** The arbitrary-code-execution tools, same set the H2 confirm gate uses. */
const EXEC_TOOLS = ['shell_execute', 'code_execute', 'shell_execute_background'] as const
/** Staged-and-approved writes in Ask mode. */
const WRITE_TOOLS = ['file_write', 'file_edit'] as const

/**
 * The ruleset behind a preset. Plan mode derives its denials from
 * MUTATING_TOOLS so the catalog strip, the runtime filter and this table can
 * never drift apart. shell_execute stays 'allow' by name on purpose: since the
 * 2.6.6 tool merge it carries the git inspectors, so its GATE is the command
 * classifier in the executor, not the tool name (see allowedInReadOnlyTurn).
 */
export function codexModeRuleset(mode: CodexMode): CodexModeRule[] {
  if (mode === 'bypass') return [{ pattern: '*', decision: 'allow' }]
  if (mode === 'plan') {
    return [
      ...[...MUTATING_TOOLS]
        .filter((name) => name !== 'shell_execute')
        .sort()
        .map((pattern): CodexModeRule => ({ pattern, decision: 'deny' })),
      { pattern: '*', decision: 'allow' },
    ]
  }
  return [
    ...EXEC_TOOLS.map((pattern): CodexModeRule => ({ pattern, decision: 'ask' })),
    ...WRITE_TOOLS.map((pattern): CodexModeRule => ({ pattern, decision: 'ask' })),
    { pattern: '*', decision: 'allow' },
  ]
}

function patternMatches(pattern: string, name: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

/** First matching rule wins, exactly like the opencode permission table. */
export function decideForTool(rules: readonly CodexModeRule[], toolName: string): PermissionDecision {
  for (const rule of rules) {
    if (patternMatches(rule.pattern, toolName)) return rule.decision
  }
  return 'allow'
}

export interface CodexModeKnobs {
  /** awaitApproval is wired for the arbitrary-exec tools this run. */
  confirmExec: boolean
  /** file_write / file_edit go through Stage-and-Approve instead of disk. */
  stageWrites: boolean
  /** The read-only chain is armed: catalog strip, shell flag, runtime filter. */
  readOnly: boolean
  /** Swap in the plan system prompt (explore, write the plan, stop). */
  planPrompt: boolean
}

export interface CodexModeKnobInput {
  mode: CodexMode
  settings: {
    codexConfirmShell?: boolean
    codexCloudConfirmOptIn?: boolean
    codexStageMode?: boolean
    codexReviewMode?: boolean
  }
  /** Provider driving this run, for the cloud arm of the shell gate. */
  providerId: string
  /** True when a read-only slash command (/review, /plan, ...) started the turn. */
  readOnlyTurn?: boolean
}

/**
 * Effective knobs = f(mode, settings). Pure, so the gate path and the request
 * path cannot disagree, and so a test can prove no settings write happens.
 *
 * The cloud shell gate is not a fourth mode: it is the user's own opt-in and
 * is off by default, so on a cloud model every mode behaves exactly as it does
 * on a local one (David 2026-08-22). A user who opts in gets the cloud confirm
 * in all three modes, Bypass included.
 *
 * Where a mode and Code-Review Mode or a read-only slash command disagree, the
 * more restrictive behaviour wins.
 */
export function codexModeKnobs(input: CodexModeKnobInput): CodexModeKnobs {
  const { mode, settings, providerId } = input
  const reviewMode = settings.codexReviewMode === true
  const readOnlyTurn = input.readOnlyTurn === true
  const cloudOptIn = settings.codexCloudConfirmOptIn === true
  const restrictedRead = reviewMode || readOnlyTurn

  if (mode === 'bypass') {
    return {
      // Local asking off. Nothing else asks unless the user opted in.
      confirmExec: codexConfirmEnabled({ confirmShell: false, cloudOptIn, providerId }),
      // Restrictive wins: a read-only turn has nothing to stage anyway.
      stageWrites: false,
      readOnly: restrictedRead,
      planPrompt: false,
    }
  }

  if (mode === 'plan') {
    return {
      // Nothing mutating survives the read-only chain, so the confirm gate
      // keeps following the user's own settings here, cloud opt-in included.
      confirmExec: codexConfirmEnabled({
        confirmShell: settings.codexConfirmShell === true,
        cloudOptIn,
        providerId,
      }),
      stageWrites: false,
      readOnly: true,
      planPrompt: true,
    }
  }

  return {
    // Ask means ask, on every provider.
    confirmExec: true,
    // opencode asks on edits too in ask/plan. We use the Stage-and-Approve
    // queue that already exists for exactly that review step.
    stageWrites: !restrictedRead,
    readOnly: restrictedRead,
    planPrompt: false,
  }
}

/**
 * Which mode "Approve and run" executes the plan under (plan C1, blocker S7).
 *
 * The plan is a function of UNTRUSTED repo content (READMEs, file names, an
 * AGENTS.md), so the execution never lands in Bypass implicitly. Order:
 *   1. a mode the user explicitly parked during the plan run wins, it is their
 *      last visible choice and the button shows it,
 *   2. otherwise the mode from BEFORE plan mode, except Bypass, which becomes
 *      Ask,
 *   3. a conversation that STARTED in plan mode gets Ask, never the global
 *      default (which could itself be Bypass).
 */
export function resolveApproveTargetMode(input: {
  parked?: unknown
  previous?: unknown
}): CodexMode {
  // 1. The user's last visible choice during the plan run wins.
  if (isCodexMode(input.parked) && input.parked !== 'plan') return input.parked
  // 2. The mode from before plan mode, minus Bypass: an untrusted plan never
  //    inherits an unattended run.
  if (isCodexMode(input.previous) && input.previous !== 'plan' && input.previous !== 'bypass') {
    return input.previous
  }
  // 3. Started in plan mode, or came from Bypass: Ask. Never the global
  //    default, which could itself be Bypass.
  return 'ask'
}
