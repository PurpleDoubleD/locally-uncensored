/**
 * The agent's workspace folder, pinned to the conversation instead of its
 * title.
 *
 * WHAT WENT WRONG (counter-check round 2 on the installed Windows build,
 * 2026-08-29). `chatWorkspaceSlug` builds `<title-kebabbed>-<id6>`, and the
 * app auto-renames a chat after the first user message. Round one of an agent
 * run wrote to `agent-workspace\new-chat-5e61db\r2a.txt`; by round two the
 * title had become the first message, so the very same run looked for its file
 * in `agent-workspace\create-a-file-called-r2a-txt-containing-5e61db\` and got
 * "File not found". The model lost everything it had written mid-task and
 * started arguing with itself about it.
 *
 * THE RULE NOW. A conversation's folder name is decided ONCE and then pinned
 * in `agentModeStore.workspaceSlugs` (persisted, so it survives a restart).
 * Every later turn reads the pin, so a rename, automatic or by hand, cannot
 * move the ground the agent is standing on.
 *
 * WHY PIN AND NOT RENAME THE FOLDER. Migrating the directory on every rename
 * would also keep the name honest, but a rename in the middle of a run pulls
 * the rug out from under open file handles and a shell working directory. The
 * folder must not move while an agent is inside it, so the name is what stays
 * put.
 *
 * EXISTING FOLDERS. Chats from before this fix have no pin. Their folder name
 * still ends in the stable `-<id6>` suffix, so before pinning anything new we
 * list `~/agent-workspace` once and adopt the folder that carries this
 * conversation's suffix. That is the fallback search; it costs one directory
 * read per app session and keeps old work reachable.
 */

import { backendCall } from './backend'
import { chatWorkspaceSlug, workspaceIdPart } from './agent-context'
import { useAgentModeStore } from '../stores/agentModeStore'

/**
 * Pick the existing workspace folder that belongs to `convId`, or null.
 *
 * A legacy name is `<title>-<id6>` and a title-less one is bare `<id6>`, so
 * the suffix is the whole test. Sorted before picking so two folders that
 * somehow share a suffix always resolve to the same one. An empty conversation
 * id is refused outright: its id part is the shared `noid` bucket, and
 * adopting a folder on that basis would hand one chat another chat's files.
 */
export function pickLegacyWorkspaceSlug(dirNames: string[], convId: string): string | null {
  if (!convId) return null
  const idPart = workspaceIdPart(convId)
  if (idPart === 'noid') return null
  const suffix = `-${idPart}`
  const hits = dirNames
    .filter((n) => typeof n === 'string' && (n === idPart || n.endsWith(suffix)))
    .sort()
  return hits[0] ?? null
}

// One directory read per app session. The listing only ever answers the
// question "does a folder for this OLD chat already exist", and a chat created
// in this session gets its pin on first use, so a stale listing cannot cost us
// anything. Parked on globalThis for the same reason agent-context.ts parks its
// state there: the bundler duplicates small modules.
const CACHE_KEY = '__lu_agent_workspace_dirs__'

function cache(): { dirs?: Promise<string[]> } {
  const g = globalThis as unknown as Record<string, { dirs?: Promise<string[]> }>
  if (!g[CACHE_KEY]) g[CACHE_KEY] = {}
  return g[CACHE_KEY]
}

/** Test-only: forget the cached directory listing. */
export function __resetWorkspaceDirCacheForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[CACHE_KEY]
}

/**
 * Sub-folder names of `~/agent-workspace`, empty when the backend cannot
 * answer (browser/dev, command missing, unreadable folder). Never throws: a
 * failed listing only means no legacy folder is adopted.
 */
async function listWorkspaceDirs(): Promise<string[]> {
  const c = cache()
  if (!c.dirs) {
    c.dirs = backendCall<string[]>('list_agent_workspaces')
      .then((names) => (Array.isArray(names) ? names.filter((n) => typeof n === 'string') : []))
      .catch(() => [])
  }
  return c.dirs
}

/**
 * The folder name this conversation's agent tools write into.
 *
 * Pinned on first use and stable from then on. Callers are the two agent
 * entry points (useAgentChat, useCodex); everything downstream takes the
 * resolved value on the run context so one turn cannot resolve it twice and
 * disagree with itself.
 */
export async function resolveChatWorkspaceSlug(
  convId: string,
  title?: string | null,
): Promise<string> {
  const store = useAgentModeStore.getState()
  const pinned = store.workspaceSlugs?.[convId]
  if (pinned) return pinned

  const legacy = pickLegacyWorkspaceSlug(await listWorkspaceDirs(), convId)
  const slug = legacy ?? chatWorkspaceSlug(convId, title)
  useAgentModeStore.getState().pinWorkspaceSlug(convId, slug)
  return slug
}
