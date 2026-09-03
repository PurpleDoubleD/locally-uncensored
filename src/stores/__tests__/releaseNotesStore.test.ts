/**
 * B4 (David 2026-08-04): "what is new" once per VERSION.
 *
 * The whole feature is one decision, and it has exactly one trap: a null flag
 * means two different things. A fresh install has never stored one, and so does
 * anyone upgrading from a build that predates the store. Show the popup on both
 * and every new customer is greeted by release notes for software they have
 * never used. Suppress it on both and no upgrade ever sees it. So the rule
 * needs a second signal, and this file is where that is pinned down.
 *
 * Run: npx vitest run src/stores/__tests__/releaseNotesStore.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useReleaseNotesStore, shouldShowReleaseNotes } from '../releaseNotesStore'
import { RELEASE_NOTES, releaseNoteFor } from '../../lib/release-notes'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** A version that really has notes, read from the table rather than hardcoded. */
const KNOWN = RELEASE_NOTES[0].version
const UNKNOWN = '9.9.9'

beforeEach(() => useReleaseNotesStore.setState({ lastNotesVersion: null }))

describe('the notes table', () => {
  it('has at least one entry, so the rest of this file means something', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0)
    expect(releaseNoteFor(KNOWN)).toBeDefined()
    expect(releaseNoteFor(UNKNOWN)).toBeUndefined()
  })

  it('every entry has a headline and at least two lines', () => {
    for (const n of RELEASE_NOTES) {
      expect(n.headline.trim().length, `${n.version}: headline`).toBeGreaterThan(10)
      expect(n.lines.length, `${n.version}: lines`).toBeGreaterThanOrEqual(2)
      for (const l of n.lines) expect(l.trim().length, `${n.version}: empty line`).toBeGreaterThan(0)
    }
  })

  it('no version appears twice', () => {
    const versions = RELEASE_NOTES.map((n) => n.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('THE version being shipped has an entry, and it is the newest one', () => {
    // The table's own rule is that a version without an entry shows no popup.
    // That rule is honest and it is also a trap: the release goes out silent
    // and nobody notices, because nothing fails. 2.6.5 was bumped everywhere
    // on 2026-08-12 while this table still ended at 2.6.4, and the only thing
    // that would have caught it was someone remembering. So the version in
    // package.json is now part of the suite.
    const shipping = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'),
    ).version as string
    expect(releaseNoteFor(shipping), `no release note for ${shipping}`).toBeDefined()
    expect(RELEASE_NOTES[0].version, 'the shipping version belongs at the top').toBe(shipping)
  })

  it('the shipping entry covers what actually shipped, not the state it was written in', () => {
    // The existence guard above has a blind spot: an entry written early stays
    // green while the branch moves on, so the shipping note is pinned to the
    // headline features of the release it ships with. For 2.6.8 those are the
    // effort control on reasoning models, GLM 5.3 in the cloud catalogue, the
    // built-in engine renamed to LU Engine, the engine that steps off a taken 8127, the model that stays Installed, the
    // ComfyUI installer that repairs its own environment, the model folder
    // that is finally read, the CivitAI key field, the HIP SDK on Windows with
    // its vram_total mix-up, the Linux packages that name libvulkan1, the
    // Coding Agent working directory, Document Chat in Cloud mode, the prompt
    // history that clears, and the side panel that folds away. Each anchor
    // below names one of them, so a note that forgets one fails here.
    // The house formula for hardware nobody here owns is pinned too: a claim
    // we could not run on real hardware says so in those words.
    const shipping = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'),
    ).version as string
    const note = releaseNoteFor(shipping)
    const prose = [
      note?.headline ?? '',
      ...(note?.lines ?? []),
      ...(note?.details ?? []).flatMap((s) => s.items),
    ]
      .join('\n')
      .toLowerCase()
    for (const anchor of [
      'effort', 'glm 5.3', 'installed', 'lu engine', '8127',
      'repair environment', 'model storage', 'civitai', 'hip sdk',
      'vram_total', 'libvulkan1', 'working directory', 'document chat',
      'prompt history', 'side panel', 'researched rather than proven', 'apple music', 'too big to scan',
      // A14 third review: "moves to a free port when 8127 is taken" reads on
      // its own as if the engine then lives there. It does not, and the note
      // has to say which one of the two it is.
      'begins at 8127 again',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
  })

  it('says nothing in the shipping note twice, word for word', () => {
    // A14 third review: "The built-in engine is called LU Engine from now on."
    // stood in `lines` and again in `details.Local`, identical to the letter.
    // Two copies of one sentence drift apart at the next edit, and until they
    // do, the reader meets the same statement twice in one popup. The summary
    // lines are a summary; the details are the detail.
    const shipping = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'),
    ).version as string
    const note = releaseNoteFor(shipping)
    // Long sentences only: a short one can legitimately repeat.
    const sentences = (text: string) =>
      text.split(/(?<=\.)\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 30)
    const inLines = new Set((note?.lines ?? []).flatMap(sentences))
    const repeated = (note?.details ?? [])
      .flatMap((s) => s.items)
      .flatMap(sentences)
      .filter((x) => inLines.has(x))
    expect(repeated, 'said word for word in both places').toEqual([])
  })

  it('every file that carries the version carries the same one', () => {
    // package-lock.json sat at 2.6.2 for three releases while everything else
    // moved, because a version bump touches four files and only three of them
    // are obvious. It does not change the built app, but it is the file a
    // packager reads, and a wrong number here is a wrong number in a bug report.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const shipping = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
    expect(lock.version, 'package-lock.json root').toBe(shipping)
    expect(lock.packages?.['']?.version, 'package-lock.json self entry').toBe(shipping)
    const tauri = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    expect(tauri.version, 'tauri.conf.json').toBe(shipping)
    const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8')
    expect(cargo, 'Cargo.toml').toContain(`version = "${shipping}"`)
  })

  it('2.6.3 carries full details with a Local and a Cloud section', () => {
    const note = releaseNoteFor('2.6.3')
    const titles = (note?.details ?? []).map((s) => s.title)
    expect(titles).toContain('Local')
    expect(titles).toContain('Cloud')
    for (const s of note?.details ?? []) {
      expect(s.items.length, `${s.title}: items`).toBeGreaterThanOrEqual(3)
      for (const i of s.items) expect(i.trim().length, `${s.title}: empty item`).toBeGreaterThan(0)
    }
  })

  it('the modal renders the expander and the sections', () => {
    // Source guard, same pattern as the settings guards: the sheet must offer
    // Show all changes and map note.details, or the table above is dead data.
    const { readFileSync } = require('node:fs')
    const { resolve } = require('node:path')
    const src = readFileSync(resolve(__dirname, '../../components/release/ReleaseNotesModal.tsx'), 'utf8')
    expect(src).toContain('Show all changes')
    expect(src).toContain('note.details.map')
    expect(src).toContain('section.items.map')
  })
})

describe('shouldShowReleaseNotes', () => {
  it('shows for an upgrade from a build that had no store yet', () => {
    // The 2.6.2 to 2.6.3 case: onboarding was done long ago, the flag is null
    // because this store did not exist there.
    expect(shouldShowReleaseNotes(KNOWN, null, true)).toBe(true)
  })

  it('shows for an upgrade from a version whose notes were already read', () => {
    expect(shouldShowReleaseNotes(KNOWN, '2.6.0', true)).toBe(true)
  })

  it('does NOT show again once this version was seen', () => {
    expect(shouldShowReleaseNotes(KNOWN, KNOWN, true)).toBe(false)
  })

  it('does NOT show while onboarding is still running', () => {
    // This is the fresh-install guard. Onboarding owns the whole screen, and
    // finish() stamps the current version, so a new user never reaches the
    // "null means upgraded" branch above.
    expect(shouldShowReleaseNotes(KNOWN, null, false)).toBe(false)
  })

  it('stays quiet for a version nobody wrote notes for', () => {
    // A release that ships without notes shows no sheet rather than a headline
    // with nothing under it.
    expect(shouldShowReleaseNotes(UNKNOWN, null, true)).toBe(false)
    expect(shouldShowReleaseNotes(UNKNOWN, '2.6.0', true)).toBe(false)
  })
})

describe('the fresh-install sequence end to end', () => {
  it('a new user who finishes onboarding never sees the notes for that build', () => {
    const store = useReleaseNotesStore.getState()
    // Before onboarding finishes: nothing stored, nothing shown.
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, false)).toBe(false)
    // Onboarding.finish() does exactly this.
    store.markNotesSeen(KNOWN)
    // Now onboarded, and the sheet stays down.
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, true)).toBe(false)
  })

  it('that same user DOES see the notes for the next version', () => {
    useReleaseNotesStore.getState().markNotesSeen(KNOWN)
    // Pretend the next build ships with its own entry.
    expect(useReleaseNotesStore.getState().lastNotesVersion).toBe(KNOWN)
    expect(shouldShowReleaseNotes(KNOWN, KNOWN, true)).toBe(false)
    // A different current version with notes would show; proven with the table
    // entry itself so this cannot pass on a typo.
    expect(shouldShowReleaseNotes(KNOWN, 'something-older', true)).toBe(true)
  })

  it('dismissing stamps the version so it does not return', () => {
    expect(shouldShowReleaseNotes(KNOWN, null, true)).toBe(true)
    useReleaseNotesStore.getState().markNotesSeen(KNOWN)
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, true)).toBe(false)
  })
})

describe('the notes describe what actually shipped', () => {
  // The 2.6.5 sheet claimed "A refused tool call ends the run at once and says
  // why, instead of the agent carrying on as if it had permission." The commit
  // it was written for (7110df26) changes how an HTTP 4xx from the MODEL
  // SERVER is classified. Nothing in the release touches tool permissions, so
  // the one line most likely to be read as a fix for the approval flow
  // promised something that is not in the build (review 2026-08-14).
  const notesSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/release-notes.ts'), 'utf8',
  )
  const changelog = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../CHANGELOG.md'), 'utf8',
  )

  it('does not promise a tool-permission fix this release does not contain', () => {
    expect(notesSrc).not.toContain('as if it had permission')
    expect(changelog).not.toContain('as if it had permission')
  })

  it('says what the 4xx change really does, in both places', () => {
    expect(notesSrc).toContain('A request the model server refuses ends the run at once')
    expect(changelog).toContain('A request the model server refuses ends the run at once')
  })
})
