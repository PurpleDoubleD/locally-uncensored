// The colour settle at the seams of a long clip (B18, 3.0.9). The work is a
// numpy step in ComfyUI's own Python, started by the Rust command
// video_color_settle (src-tauri/src/commands/video_settle.rs): each section
// is matched to the settled one before it, so the whole clip keeps the
// colours of its first section. The command only reaches a ComfyUI LU manages
// on this machine; anywhere else this returns null and the clip stays as it
// came out.

import { backendCall, isTauri } from './backend'
import { log } from '../lib/logger'

export interface SettleReport {
  filename: string
  subfolder: string
  frames?: number
}

/** The settled copy of a ComfyUI output video, or null when it cannot be made. */
export async function settleSeams(
  item: { filename?: string; subfolder?: string; comfyType?: string },
  boundaries: number[],
): Promise<SettleReport | null> {
  if (!isTauri() || !item.filename || boundaries.length === 0) return null
  try {
    const report = await backendCall<SettleReport>('video_color_settle', {
      filename: item.filename,
      subfolder: item.subfolder ?? '',
      folderType: item.comfyType === 'input' ? 'input' : 'output',
      boundaries,
      window: 5,
    })
    return report?.filename ? report : null
  } catch (e) {
    log.info(`[video-settle] skipped: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
