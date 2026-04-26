/**
 * Per-agent-run chat context — maps the currently executing agent loop
 * back to the conversation it belongs to. Lets the built-in tool
 * executors (`file_read`, `file_write`, `execute_code`, `shell_execute`)
 * thread a `chatId` through to the Rust side WITHOUT changing their
 * public args shape or polluting the tool JSON schema the model sees.
 *
 * How it flows:
 *   1. useAgentChat / useCodex / useClaudeCode → setActiveChatId(convId)
 *      at the start of their agent loop.
 *   2. Tool executors in `src/api/mcp/builtin-tools.ts` → backendCall
 *      includes `{ chatId: getActiveChatId() }` in the request body.
 *   3. Rust tool commands resolve relative paths against
 *      `~/agent-workspace/<chatId>/`, so every chat gets its own
 *      isolated workspace folder, created lazily on first write.
 *
 * When unset (standalone tool calls outside an agent loop), Rust falls
 * back to `~/agent-workspace/default/` so nothing ever lands in the
 * legacy shared folder.
 */

let activeChatId: string | null = null

export function setActiveChatId(id: string | null | undefined): void {
  activeChatId = id ? String(id) : null
}

export function getActiveChatId(): string | null {
  return activeChatId
}

export function clearActiveChatId(): void {
  activeChatId = null
}

/**
 * Build a human-readable workspace slug for a chat.
 *
 * Folders used to be named after the conversation UUID
 * (`~/agent-workspace/8f7c2a1b-…/`), which is technically unique but
 * useless to a human opening Explorer. Per user feedback, slug is now
 * `<title-kebabbed>-<6-char-id>` so the user can find their work.
 *
 * The 6-char id suffix keeps two chats with the same title from
 * colliding (e.g. two "Untitled" chats started in a row).
 *
 * Sanitisation: lowercase, ASCII alphanumerics + hyphen only, capped
 * at 40 chars. Empty / unprintable titles fall back to the UUID
 * suffix alone, which still gives a stable folder name. The Rust side
 * has its own paranoia layer (agent.rs::agent_workspace) so this is
 * defence in depth.
 */
export function chatWorkspaceSlug(id: string, title?: string | null): string {
  const idPart = (id || '').replace(/-/g, '').slice(0, 6) || 'noid'
  const rawTitle = (title || '').toLowerCase().trim()
  if (!rawTitle) return idPart
  const slug = rawTitle
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug ? `${slug}-${idPart}` : idPart
}
