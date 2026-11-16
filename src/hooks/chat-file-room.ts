/**
 * The send-time half of GH #171: resolve the window of the model(s) a message
 * goes to, fit its attached text files into it (lib/chat-file-fit.ts), and
 * tell the user when a file went out shorter.
 *
 * The window is asked through `resolveModelContext`, the body of the context
 * counter, so the number a file is measured against is the number the user
 * sees in the header: the real num_ctx on Ollama (with the user's own
 * setting), the loaded context on LM Studio and the built-in engine, the
 * window a user set for their own OpenAI-compatible server (GH #129), the
 * catalogue value elsewhere.
 */
import type { Conversation, FileAttachment } from '../types/chat'
import type { WindowUse } from '../lib/context-window'
import { getProviderIdFromModel } from '../api/providers'
import { estimateTokens, getModelMaxTokens } from '../lib/context-compaction'
import { effectiveSendWindow, sendWindowFor } from '../lib/send-window'
import { sendsToALanBackend } from '../lib/lan-openai-slot'
import { fileCutNotice, fileRoom, fitFiles, tighterRoom, type FileRoom } from '../lib/chat-file-fit'
import { heldText } from '../lib/chat-files'
import { useSettingsStore } from '../stores/settingsStore'
import { useChatNoticeStore } from '../stores/chatNoticeStore'
import { MEMORY_CONTEXT_TOKEN_CAP, memoryContextCeiling, useMemoryStore } from '../stores/memoryStore'
import { log } from '../lib/logger'
import { applyStoredCompaction } from '../lib/compact-summary'
import { currentContextKnobs, resolveModelContext } from './useActiveContextWindow'

/**
 * Share of the send budget an attached text may take in Agent and Code. Their
 * requests also carry the tool catalogue and every step of the run, none of
 * which is in the history yet when the file is fitted, and the file itself is
 * in the working folder for the tools to read in full.
 */
export const WORKSPACE_FILE_SHARE = 0.5

/**
 * Room kept for what joins the system prompt only after the file is fitted:
 * remembered context (at most MEMORY_CONTEXT_TOKEN_CAP, 1000), a retrieval
 * block, the thinking and style lines. Measured against an 8K window this is
 * a quarter; against the 262K window of the report it is under one percent.
 * A memory override may lift that ceiling (GH #238); `roomForModel` keeps
 * the difference free as well.
 */
export const PROMPT_EXTRAS_RESERVE_TOKENS = 2048

/**
 * The rest of the request as text: the chat's system prompt, the history as
 * it will be sent (a recorded compaction stands in for what it covers) and
 * what the user typed.
 */
export function requestTextOf(conv: Pick<Conversation, 'systemPrompt' | 'messages' | 'compactions'> | undefined, typed: string): string {
  if (!conv) return typed
  const history = applyStoredCompaction(
    conv.messages.filter((m) => m.role !== 'system' && m.content.trim() !== ''),
    conv.compactions,
  )
  return [conv.systemPrompt ?? '', history.rendered, ...history.messages.map((m) => m.content), typed].join('\n')
}

async function roomForModel(model: string, use: WindowUse, otherTokens: number): Promise<FileRoom> {
  const settings = useSettingsStore.getState().settings
  let window = 0
  try {
    window = (await resolveModelContext(model, use, currentContextKnobs())).contextWindow
  } catch (err) {
    log.warn('[chat-files] the context window could not be resolved for an attachment', { err: String(err) })
  }
  if (!(window > 0)) window = await getModelMaxTokens(model)
  // GH #238: a memory override lets the memory block grow past the 1k this
  // reserve was sized for, up to a tenth of the window.
  const memoryCeiling = memoryContextCeiling(window, useMemoryStore.getState().settings.maxMemoriesOverride)
  const reserved = otherTokens + Math.max(0, memoryCeiling - MEMORY_CONTEXT_TOKEN_CAP)
  const providerId = getProviderIdFromModel(model)
  const budget = effectiveSendWindow({
    providerId,
    modelWindow: window,
    sendWindowTokens: sendWindowFor(settings, model),
    capEnabled: settings.contextDecay,
    localBackend: sendsToALanBackend(providerId, model),
  })
  return fileRoom({
    window,
    payloadBudget: use === 'agent' ? Math.floor(budget * WORKSPACE_FILE_SHARE) : budget,
    otherTokens: reserved,
    limit: settings.attachmentTokenLimit,
  })
}

export interface FitForSendInput {
  files: FileAttachment[] | undefined
  /** Every model that reads this message: one, or the speakers of a group. */
  models: readonly string[]
  use: WindowUse
  /** Everything else the request carries, as text: system prompt, history,
   *  what the user typed. Estimated with the same function as the files. */
  otherText: string
  surface?: 'chat' | 'workspace'
}

/**
 * The files as they go out. Returns the input unchanged, without asking for a
 * window, when no attached file has a text to fit.
 */
export async function fitFilesForSend(input: FitForSendInput): Promise<FileAttachment[] | undefined> {
  const { files } = input
  // Clear the line of the previous message first: it was about that one.
  useChatNoticeStore.getState().dismiss('file-cut')
  if (!files?.length || !files.some((f) => heldText(f) !== null)) return files
  const otherTokens = estimateTokens(input.otherText) + PROMPT_EXTRAS_RESERVE_TOKENS
  let room: FileRoom | null = null
  for (const model of input.models) room = tighterRoom(room, await roomForModel(model, input.use, otherTokens))
  if (!room) return files
  const fitted = fitFiles(files, room, input.surface)
  const notice = fileCutNotice(fitted.cut, room)
  if (notice) {
    log.info('chat.file_cut', { reason: room.reason, room: room.tokens, files: fitted.cut.length })
    useChatNoticeStore.getState().show('file-cut', notice, 'ruhig')
  }
  return fitted.files
}
