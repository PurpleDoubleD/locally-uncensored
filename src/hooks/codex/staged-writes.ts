import { useStagedChangesStore } from '../../stores/stagedChangesStore'
import { computeUnifiedDiff } from '../../lib/diff'
import { applyEdits, editsFromArgs } from '../../lib/surgical-edit'
import { findStagedForPath, stagedReadResult, stagedListingNote } from '../../lib/staged-overlay'
import { codexReadCtx, type CodexFsCtx, type CodexFileRead } from './workspace-fs'
import type { ToolArgs } from '../../api/mcp/types'
import type { StagedReview } from '../../lib/staged-apply'
import type { ReviewNote } from '../../types/staged-changes'

/** What the model hears after a blocking review. A partial apply (some hunks
 *  rejected) left a note for this change; that note is the better answer. */
export function reviewResult(review: StagedReview, path: string, kind: 'write' | 'edit', note?: string): string {
  if (note && (review.outcome === 'applied' || review.outcome === 'rejected')) return note
  switch (review.outcome) {
    case 'applied': return kind === 'write' ? `Wrote ${path}. The user approved the change and it is on disk now.` : `Edited ${path}. The user approved the change and it is on disk now.`
    case 'rejected': return `The user declined this change. ${path} was not written.`
    case 'replaced': return `A later write to ${path} in this turn replaced this one; that one is reviewed instead.`
    case 'failed': return `The approved change to ${path} could not be written: ${review.reason}`
    case 'stopped': return `The run was stopped before the change to ${path} was reviewed. Nothing was written.`
  }
}

/**
 * Die Warteschlange der noch nicht geschriebenen Aenderungen — und ALLES, was
 * sie anfasst.
 *
 * Das ist der Schnitt nach GETEILTEM ZUSTAND, wie ihn ZB-7 fuer `dev-server/`
 * gezogen hat. Der veraenderliche Zustand ist `stagedChangesStore`, und in
 * useCodex.ts lagen VIER Zugriffe darauf ueber 60 Zeilen verstreut, die nur
 * zusammen richtig sind:
 *
 *   1. `stageFileWrite`  legt eine ganze Datei in die Schlange,
 *   2. `stageFileEdit`   loest old_string→new_string JETZT auf und legt das
 *                        Ergebnis in die Schlange,
 *   3. `file_read`       muss AUS der Schlange beantwortet werden,
 *   4. `file_list`/`file_search` muessen die Schlange ANMERKEN.
 *
 * Warum 3 und 4 hier stehen und nicht beim Werkzeug-Versand: eine abgelegte
 * Schreibung ist auf der Platte UNSICHTBAR. Liest das Modell danach die alten
 * Bytes (oder ein "nicht gefunden"), schliesst es, sein Schreiben sei
 * gescheitert, und legt dieselbe Datei wieder und wieder ab — Morgans
 * `file_read`-Schleife vom 2026-07-26. Wer die Schlange fuellt und wer sie
 * liest, gehoert deshalb in EIN Modul; getrennt koennen sie auseinanderlaufen,
 * und genau das ist zweimal passiert.
 *
 * DIE ZWEITE GEMEINSAMKEIT, die den Schnitt traegt: 2 und 3 lasen den
 * Grundtext frueher jeweils von der PLATTE. Bei einer zweiten Bearbeitung
 * derselben Datei ueberschrieb das still die erste, und eine Bearbeitung an
 * einer abgelegten NEUEN Datei scheiterte mit "could not read". Die
 * Lies-deine-Schreibungen-Regel (`findStagedForPath` vor dem Plattenzugriff)
 * ist in 1 und 2 dieselbe Regel und steht jetzt zweimal nebeneinander statt
 * zweimal quer durch die Datei.
 *
 * WAS BEWUSST VERSCHIEDEN BLEIBT, weil es Verhalten ist und keine Doppelung:
 * `stageFileWrite` nimmt bei einem Vorgaenger dessen `oldContent` (die
 * Plattenfassung), `stageFileEdit` nimmt dessen `newContent` als GRUNDLAGE und
 * dessen `oldContent` als Vergleichsbasis. Der geprueft angezeigte Unterschied
 * ist in beiden Faellen Platte → Endstand, nie abgelegt → abgelegt.
 *
 * `readFile` kommt von aussen (dieselbe Naht wie `RulesReader` in
 * `workspace-fs.ts` und wie `realPath` im Pfad-Kaefig des Dev-Servers): der
 * echte Leser spricht mit dem Rust-Backend, im Test steht ein echter
 * Dateiinhalt dahinter. Ohne diese Naht waere von den vier Regeln oben keine
 * einzige pruefbar.
 */

/** Review notes as one block for the model. Short on purpose. */
export function reviewNotesText(notes: readonly ReviewNote[]): string {
  return `[User review: ${notes.map((n) => n.text).join(' ')}]`
}

export interface StagedWriterDeps {
  convId: string
  /** Der Ordner, den auch der Systemprompt nennt. `'.'` = Sandbox pro Chat. */
  workDir: string
  workspaceSlug: string
  readFile: (path: string, ctx: CodexFsCtx) => Promise<CodexFileRead>
  /**
   * Set for a turn from the paired phone (shared chats): the write waits for
   * its review (once/chat/deny on the phone, or Apply/Reject at the desktop)
   * and the model hears what really happened. Without it the write is staged
   * and the run goes on, as at the desktop.
   */
  waitForReview?: (changeId: string, path: string) => Promise<StagedReview>
}

export interface StagedWriter {
  stageFileWrite(args: ToolArgs): Promise<string>
  stageFileEdit(args: ToolArgs): Promise<string>
  /**
   * Der Versand einer Runde mit eingeschalteter Ablage. `passthrough` ist der
   * echte Weg zum Werkzeug (mit Zeitgrenze und Abbruchsignal); er bleibt beim
   * Aufrufer, weil nur der den Lauf kennt.
   */
  dispatch(name: string, args: ToolArgs, passthrough: () => Promise<string>): Promise<string>
}

/**
 * Der Pfad, unter dem eine abgelegte Aenderung SPAETER landet.
 *
 * JETZT aufgeloest, nicht beim Anwenden: das Anwenden laeuft, nachdem das
 * `finally` dieses Zuges den aktiven Chat- und Workspace-Kontext geraeumt hat,
 * und ein relativer Pfad zeigte dann nach `agent-workspace/default/` statt in
 * den echten Projektordner.
 */
function resolveStagedPath(path: string, workDir: string): string {
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/]|\\\\)/.test(path)
  return isAbs || !workDir || workDir === '.'
    ? path
    : `${workDir.replace(/[\\/]+$/, '')}${workDir.includes('\\') ? '\\' : '/'}${path.replace(/^[\\/]+/, '')}`
}

export function createStagedWriter(deps: StagedWriterDeps): StagedWriter {
  const { convId, workDir, workspaceSlug, readFile, waitForReview } = deps

  // A blocking review answers in the tool result itself, so its note is taken
  // here and not handed out a second time with a later result.
  const reviewed = async (stagedId: string, path: string, kind: 'write' | 'edit'): Promise<string> => {
    const review = await waitForReview!(stagedId, path)
    const note = useStagedChangesStore.getState().takeNotes(convId, stagedId)[0]?.text
    return reviewResult(review, path, kind, note)
  }

  // Multi-File Stage-and-Approve (B10). When the user has codex
  // stage mode on, file_write calls don't hit the disk — they
  // queue in stagedChangesStore as "pending changes" the user
  // reviews and applies (or rejects) per-file. The model still
  // sees a synthetic success message so the loop progresses; the
  // user is the gatekeeper for the actual disk write.
  const stageFileWrite = async (args: ToolArgs): Promise<string> => {
    const path = String(args.path ?? '')
    if (!path) return 'file_write: missing path'
    const newContent = String(args.content ?? '')
    // Resolve against the run's workspace NOW (at stage time). The bridge
    // jails absolute paths to the workspace root, so the pre-read MUST pass
    // the run's workingDirectory (as its root) — otherwise the absolute
    // project path is rejected and the staged diff shows a 100% insert,
    // hiding what will be overwritten. (v2.5.0 + 2.5.9 audit fix.)
    const resolvedPath = resolveStagedPath(path, workDir)
    const stageReadCtx = codexReadCtx(workspaceSlug, workDir)
    // A prior staged entry for this path already knows the DISK state —
    // reuse it so the reviewed diff stays disk → latest even when the
    // model writes the same file twice in one run.
    const priorWrite = findStagedForPath(useStagedChangesStore.getState().list(convId), path)
    let oldContent = ''
    if (priorWrite) {
      oldContent = priorWrite.oldContent
    } else {
      try {
        const r = await readFile(resolvedPath, stageReadCtx)
        // A file that is not UTF-8 (Latin-1, UTF-16 from PowerShell) comes
        // back without content. Read as '' it was reviewed as a brand new
        // file, an all-insert diff hiding what gets overwritten (bug hunt
        // 01.10.2026, C8). Refused like file_edit refuses it.
        if (r?.encoding === 'binary' || r?.encoding === 'base64') {
          return `file_write: ${path} exists but is not a UTF-8 text file, so the review cannot show what this write would replace. It was not staged. Ask the user before overwriting it.`
        }
        oldContent = r?.content ?? ''
      } catch {
        // New file — leave oldContent empty so the diff renders an
        // all-add hunk and the apply path creates the file.
      }
    }
    const diff = computeUnifiedDiff(path, oldContent, newContent)
    const stagedId = useStagedChangesStore.getState().stage(convId, {
      path,
      resolvedPath,
      // Capture the workspace root so Apply (which runs after the loop's
      // finally clears the active context) can jail the write to the real
      // project folder instead of agent-workspace/default. Undefined in
      // sandbox mode — the per-chat sandbox is the right root there.
      workingDirectory: workDir && workDir !== '.' ? workDir : undefined,
      oldContent,
      newContent,
      diff,
    })
    if (waitForReview) return reviewed(stagedId, path, 'write')
    return `Staged for review: ${path}. The user will apply or reject the change before it lands on disk.`
  }

  // Stage-mode counterpart for surgical edits: resolve old_string ->
  // new_string against the current file NOW and stage the resulting full
  // content, so the staged diff and the applied write are the real change
  // (and a bad edit is reported the same way whether staged or not).
  const stageFileEdit = async (args: ToolArgs): Promise<string> => {
    const path = String(args.path ?? '')
    if (!path) return 'file_edit: missing path'
    const edits = editsFromArgs(args).map((e) => ({ ...e, new_string: e.new_string ?? '' }))
    const resolvedPath = resolveStagedPath(path, workDir)
    const stageReadCtx = codexReadCtx(workspaceSlug, workDir)
    // Read-your-writes: chain onto the STAGED content when this path is
    // already pending. Without this the base was re-read from DISK —
    // which never saw the staged write — so a second edit to the same
    // file silently clobbered the first, and an edit to a staged NEW
    // file failed with "could not read".
    const priorEdit = findStagedForPath(useStagedChangesStore.getState().list(convId), path)
    let baseContent = ''
    let diskContent = ''
    if (priorEdit) {
      baseContent = priorEdit.newContent
      diskContent = priorEdit.oldContent
    } else {
      try {
        const r = await readFile(resolvedPath, stageReadCtx)
        if (r?.encoding === 'binary' || r?.encoding === 'base64') return `file_edit: cannot edit a binary file (${path}).`
        baseContent = diskContent = r?.content ?? ''
      } catch {
        return `file_edit: could not read ${path}. To create a new file use file_write.`
      }
    }
    const applied = applyEdits(baseContent, edits)
    if (!applied.ok) {
      switch (applied.reason) {
        case 'empty_old': return 'file_edit: old_string must be non-empty. Use file_write to create a new file.'
        case 'noop': return 'file_edit: old_string and new_string are identical, nothing to change.'
        case 'not_found': return `file_edit: old_string not found in ${path}. Read the file and copy the exact text you want to replace.`
        case 'not_unique': return `file_edit: old_string matches ${applied.matches} places in ${path}. Add surrounding lines so it is unique.`
        default: return 'file_edit: failed.'
      }
    }
    const newContent = applied.content ?? ''
    // Diff and oldContent stay anchored on the DISK state, so the user
    // reviews (and apply writes) disk → final, not staged → staged.
    const diff = computeUnifiedDiff(path, diskContent, newContent)
    const stagedId = useStagedChangesStore.getState().stage(convId, {
      path,
      resolvedPath,
      workingDirectory: workDir && workDir !== '.' ? workDir : undefined,
      oldContent: diskContent,
      newContent,
      diff,
    })
    if (waitForReview) return reviewed(stagedId, path, 'edit')
    return `Staged for review: ${path} (surgical edit). The user will apply or reject the change before it lands on disk.`
  }

  const dispatch = (name: string, args: ToolArgs, passthrough: () => Promise<string>): Promise<string> =>
    route(name, args, passthrough).then(withReviewNotes)

  // The desktop review runs beside the loop: a file or hunk the user rejected
  // in the panel is invisible to the model, which then builds on code that is
  // not there. The next tool result carries what was rejected, once.
  const withReviewNotes = (result: string): string => {
    if (!convId) return result
    const notes = useStagedChangesStore.getState().takeNotes(convId)
    return notes.length === 0 ? result : `${result}\n\n${reviewNotesText(notes)}`
  }

  const route = (name: string, args: ToolArgs, passthrough: () => Promise<string>): Promise<string> => {
    if (name === 'file_write') return stageFileWrite(args)
    if (name === 'file_edit') return stageFileEdit(args)
    // Read-your-writes: staged content is invisible on disk, so reads
    // MUST be answered from the queue — otherwise the model reads the
    // old bytes (or a not-found), concludes its write failed, and
    // stages the same file forever (Morgan's file_read loop,
    // 2026-07-26). The in-turn cache composes correctly: every staged
    // write is audited as a file_write mutation, which invalidates
    // cached reads, so a pre-stage result is never replayed.
    const staged = convId ? useStagedChangesStore.getState().list(convId) : []
    if (staged.length > 0) {
      if (name === 'file_read') {
        const hit = findStagedForPath(staged, String(args.path ?? ''))
        if (hit) return Promise.resolve(stagedReadResult(hit))
      }
      if (name === 'file_list' || name === 'file_search') {
        return passthrough().then((r) => r + stagedListingNote(staged))
      }
    }
    return passthrough()
  }

  return { stageFileWrite, stageFileEdit, dispatch }
}
