/**
 * What `inputImage` of image_generate / video_generate names, read against
 * the chat the call came from (A13, 21.10.2026).
 *
 * The model passes a reference it read in the chat: "attachment 2" (lib/
 * chat-attachment-input), the file name of a picture an earlier call made
 * ("LU_00012_.png", "mlx-1729.png"), or the address in that result line. A12
 * made the first one work; this file makes the others exact as well:
 *
 * - A file name of an earlier result is answered with THAT result's address,
 *   subfolder and folder type included, and on a Mac with its path on disk.
 *   The lookup by bare name in ComfyUI's output root lost both.
 * - A clip is refused by name, wherever it comes from: an earlier
 *   video_generate result (Wan 2.1 writes an animated .webp, which LoadImage
 *   reads as one frame), a clip attached in the chat, a .mp4 by name.
 * - A name that is in no list here is refused on the Mac with the pictures
 *   this chat does have. On ComfyUI it may still be a gallery file the user
 *   named, so it goes on to ComfyUI's folders, and only their "not there"
 *   gets the same list added (`withChatChoices`).
 *
 * Before, a name that did not resolve took the last picture any chat had
 * made, silently, so a clip in one chat could start from another chat's image.
 */
import { getBlockToolCalls } from '../api/agents/block-helpers'
import type { AgentBlock } from '../types/agent-mode'
import { attachmentLabel, chatImageAttachments, pickAttachment, type ChatImageEntry } from './chat-attachment-input'
import { isMediaFailureResult } from './media-result'

/** A picture or clip an earlier image_generate / video_generate call of this
 *  chat delivered. */
export interface ChatResultMedia {
  kind: 'image' | 'video'
  /** The file name its result line starts with. */
  name: string
  /** The address on its last line: a ComfyUI /view, a file:// or a data: URL. */
  url: string
}

interface ChatMessageLike {
  role: string
  images?: { name?: string; mimeType?: string; data?: string }[]
  media?: { kind: string; name: string }[]
  agentBlocks?: AgentBlock[]
}

/** The file name a media result line names ("Image generated: <file> (prompt: …"). */
export function resultFileName(result: string): string | null {
  return /^\s*(?:Image|Video) generated:\s*(.+?) \(prompt:/.exec(result)?.[1] ?? null
}

/**
 * The address a media result line ends with. Only the last line is read:
 * the prompt sits on the first one, and a prompt that quotes an address
 * ("like http://localhost:8188/view?filename=x.png") was taken for the
 * result before.
 */
export function resultMediaUrl(result: string | null | undefined): string | null {
  if (!result) return null
  const tail = result.slice(result.lastIndexOf('\n') + 1).trim()
  return /^(?:https?:\/\/\S+\/view\?\S*filename=|\/(?:comfyui\/)?view\?\S*filename=|file:\/\/\S|data:(?:image|video)\/)/i.test(tail) ? tail : null
}

/** Every picture and clip this chat's media calls delivered, oldest first. */
export function chatResultMedia(messages: readonly ChatMessageLike[]): ChatResultMedia[] {
  const out: ChatResultMedia[] = []
  for (const m of messages) {
    for (const block of m.agentBlocks ?? []) {
      for (const call of getBlockToolCalls(block)) {
        if (call.toolName !== 'image_generate' && call.toolName !== 'video_generate') continue
        if (call.status !== 'completed' && call.status !== 'cached') continue
        const result = call.result ?? ''
        if (isMediaFailureResult(result)) continue
        const name = resultFileName(result)
        const url = resultMediaUrl(result)
        if (name && url) out.push({ kind: call.toolName === 'video_generate' ? 'video' : 'image', name, url })
      }
    }
  }
  return out
}

/** The clips attached in this chat, by name (they carry no bytes here). */
function attachedClips(messages: readonly ChatMessageLike[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const clip of m.media ?? []) if (clip.kind === 'video') out.push(clip.name)
  }
  return out
}

const VIDEO_NAME_RE = /\.(mp4|webm|mov|mkv|avi|m4v|gif)$/i

/** What a reference turned out to name. */
export type ChatInputRef =
  | { kind: 'attachment'; entry: ChatImageEntry }
  | { kind: 'result'; media: ChatResultMedia }
  /** A /view or http address the call passed itself. */
  | { kind: 'url'; url: string }
  /** A file on this computer: a file:// URL or an absolute path. */
  | { kind: 'path'; path: string }
  /** No picture of this chat. On ComfyUI it may still be a gallery file. */
  | { kind: 'unknown'; name: string }
  /** Goes to model and user as it is. */
  | { kind: 'error'; error: string }

/** The pictures of this chat, as the model may pass them. */
export function chatChoicesLine(attachments: readonly ChatImageEntry[], results: readonly ChatResultMedia[]): string {
  const pictures = [
    ...attachments.map((e) => `${attachmentLabel(e.number)} ("${e.name}")`),
    ...results.filter((r) => r.kind === 'image').map((r) => `"${r.name}" (made in this chat)`),
  ]
  return pictures.length
    ? `Pictures of this chat you can pass as inputImage: ${pictures.join(', ')}.`
    : 'This chat has no picture yet: make one with image_generate first, or ask the user to attach one.'
}

function clipError(name: string): string {
  return `"${name}" is a video clip, and inputImage takes a still image. Pass a picture instead; continuing or reworking a clip is not something this tool does.`
}

/** What `ref` names in the chat with these messages. */
export function resolveChatInputRef(ref: string, messages: readonly ChatMessageLike[]): ChatInputRef {
  const raw = ref.trim()
  const attachments = chatImageAttachments(messages)
  const results = chatResultMedia(messages)
  const picked = pickAttachment(raw, attachments)
  if (picked && 'error' in picked) return { kind: 'error', error: `${picked.error} ${chatChoicesLine(attachments, results)}` }
  if (picked) return { kind: 'attachment', entry: picked.entry }

  if (/^file:\/\//i.test(raw)) {
    let path: string
    try {
      path = decodeURI(raw.replace(/^file:\/\//i, ''))
    } catch {
      return { kind: 'error', error: `inputImage "${raw}" is not a readable file address.` }
    }
    return ownResultAt(path, results) ?? { kind: 'path', path }
  }
  // An address this chat produced is matched to its result, so a clip is
  // known as one even where its file name ends in .webp.
  const sameUrl = results.slice().reverse().find((r) => r.url === raw)
  if (sameUrl) return sameUrl.kind === 'video' ? { kind: 'error', error: clipError(sameUrl.name) } : { kind: 'result', media: sameUrl }
  if (/^(?:https?:\/\/|\/(?:comfyui\/)?view\?)/i.test(raw)) return { kind: 'url', url: raw }
  if (/^(?:\/|[a-z]:[\\/])/i.test(raw) && /[\\/]/.test(raw.slice(1))) return ownResultAt(raw, results) ?? { kind: 'path', path: raw }

  const base = raw.replace(/^.*[\\/]/, '')
  if (!base) return { kind: 'error', error: `inputImage is empty. ${chatChoicesLine(attachments, results)}` }
  const byName = results.slice().reverse().find((r) => r.name.toLowerCase() === base.toLowerCase())
  if (byName) return byName.kind === 'video' ? { kind: 'error', error: clipError(byName.name) } : { kind: 'result', media: byName }
  if (VIDEO_NAME_RE.test(base) || attachedClips(messages).some((n) => n.toLowerCase() === base.toLowerCase())) {
    return { kind: 'error', error: clipError(base) }
  }
  return { kind: 'unknown', name: base }
}

/**
 * D5 (Discord 07.11.2026): a path on disk whose file is a picture this chat
 * made is that result. An agent in its sandbox saw the picture in the chat,
 * found the file on disk (file_list, a folder workspace, the address in the
 * result) and passed the full path; the tool refused every path as "ComfyUI
 * cannot read it from disk", so the picture it had just made could not be
 * used again. The result's own address is what ComfyUI and the Mac read.
 * A path to anything else is still refused, so no file of the computer goes
 * into a render by this route.
 */
function ownResultAt(path: string, results: readonly ChatResultMedia[]): ChatInputRef | null {
  const base = path.replace(/^.*[\\/]/, '').toLowerCase()
  if (!base) return null
  const hit = results.slice().reverse().find((r) => r.name.toLowerCase() === base)
  if (!hit) return null
  return hit.kind === 'video' ? { kind: 'error', error: clipError(hit.name) } : { kind: 'result', media: hit }
}

/** A "could not find input image" from ComfyUI's folders, with the pictures
 *  this chat has, so the model can retry with one that is there. */
export function withChatChoices(result: string, messages: readonly ChatMessageLike[]): string {
  if (!/could not find input image/i.test(result)) return result
  return `${result} ${chatChoicesLine(chatImageAttachments(messages), chatResultMedia(messages))}`
}
