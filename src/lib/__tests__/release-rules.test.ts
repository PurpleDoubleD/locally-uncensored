/**
 * The release everyone is waiting for must not announce itself as obsolete.
 *
 * Found by the review of the D1 prerelease fix (2026-08-14). `/releases/latest`
 * returns the release flagged Latest, and we publish as a prerelease and flip
 * that flag only after verifying the build. So on the day 2.6.5 goes out it is
 * NOT latest, the old rule read that as "old", and the brand-new release got
 * "This is an old release" stamped on it within a minute of appearing. The
 * Discord announcement quotes the release body, so the banner would have gone
 * out with the announcement.
 *
 * Run: npx vitest run src/lib/__tests__/release-banner-rules.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { shouldCarryBanner, shouldForcePrerelease, withoutBanner, BANNER, MARKER } from '../../../scripts/release-rules.mjs'

const rel = (over: Record<string, unknown> = {}) => ({
  id: 1, tag_name: 'v1', prerelease: false, draft: false,
  published_at: '2026-08-01T00:00:00Z', body: '', ...over,
})

const latest = rel({ id: 100, tag_name: 'v2.6.4', published_at: '2026-08-10T00:00:00Z' })

describe('what counts as an old release', () => {
  it('the one flagged Latest never carries it', () => {
    expect(shouldCarryBanner(latest, latest)).toBe(false)
  })

  it('a shipped older release carries it', () => {
    const old = rel({ id: 2, tag_name: 'v2.5.10', published_at: '2026-07-01T00:00:00Z' })
    expect(shouldCarryBanner(old, latest)).toBe(true)
  })

  it('THE case: a fresh prerelease published after Latest stays clean', () => {
    const fresh = rel({
      id: 3, tag_name: 'v2.6.5', prerelease: true, published_at: '2026-08-14T09:00:00Z',
    })
    expect(shouldCarryBanner(fresh, latest)).toBe(false)
  })

  it('a draft published after Latest stays clean too', () => {
    const draft = rel({
      id: 4, tag_name: 'v2.6.6', draft: true, published_at: '2026-08-14T09:00:00Z',
    })
    expect(shouldCarryBanner(draft, latest)).toBe(false)
  })

  it('a prerelease that was superseded really is old and carries it', () => {
    const stale = rel({
      id: 5, tag_name: 'v2.6.2-rc', prerelease: true, published_at: '2026-07-20T00:00:00Z',
    })
    expect(shouldCarryBanner(stale, latest)).toBe(true)
  })

  it('a prerelease published the same instant as Latest counts as upcoming', () => {
    const tie = rel({ id: 6, prerelease: true, published_at: latest.published_at })
    expect(shouldCarryBanner(tie, latest)).toBe(false)
  })

  it('a missing date does not silently stamp the newest release', () => {
    // Date.parse of undefined is NaN, which would compare false against
    // everything. A release with no usable date is treated as old, which is
    // the safe direction for a shipped build, and the fresh one keeps its
    // published_at anyway.
    const undated = rel({ id: 7, prerelease: true, published_at: null, created_at: null })
    expect(shouldCarryBanner(undated, latest)).toBe(true)
  })
})

describe('the banner text itself', () => {
  it('stripping is idempotent, so a re-run never stacks two', () => {
    const body = BANNER + 'real notes\n'
    expect(withoutBanner(body)).toBe('real notes\n')
    expect(withoutBanner(withoutBanner(body))).toBe('real notes\n')
  })

  it('a body without one is returned untouched', () => {
    expect(withoutBanner('just notes')).toBe('just notes')
    expect(withoutBanner(undefined)).toBe('')
  })

  it('carries the marker the script looks for', () => {
    expect(BANNER.startsWith(MARKER)).toBe(true)
  })
})

// P4 from the review, confirmed at the source of the pinned action. release.yml
// passes `prerelease: true` to tauri-action, and tauri-action hands
// draft/prerelease to createRelease ONLY (src/create-release.ts at
// 51a9f115): when the release already exists, which it always does on
// `on: release: [published]`, the action reuses it and never patches the flag.
// So the guarantee in that comment held for workflow_dispatch and nothing else,
// and a release published as a full release went straight to Latest with the
// download routes and every updater following. That is the 2026-08-10 incident
// the comment claims was fixed.
describe('a build is not a decision, on every trigger', () => {
  const latest = rel({ id: 100, tag_name: 'v2.6.4', published_at: '2026-08-10T00:00:00Z' })

  it('a full release that is not Latest is forced back', () => {
    const fresh = rel({ id: 3, tag_name: 'v2.6.5', prerelease: false })
    expect(shouldForcePrerelease(fresh, latest)).toBe(true)
  })

  it('the release that IS Latest is never touched, or the flip would undo itself', () => {
    // No release event named it: this is a manual re-run over a tag somebody
    // already verified and flipped, and that flag is their verdict.
    expect(shouldForcePrerelease(latest, latest)).toBe(false)
  })

  // THE case the job exists for, and the one the first version of the rule could
  // never reach. Publishing a release as a full release makes GitHub point
  // Latest at it immediately and by itself — so by the time this job runs,
  // `rel.id === latest.id` is already true and the old `isLatest -> leave it
  // alone` guard fired every single time. The check was a guaranteed no-op in
  // its own core case: the release nobody had opened kept Latest, the download
  // routes and every updater followed it, which is the 2026-08-10 incident.
  it('a full release that this run just published is forced back EVEN THOUGH GitHub already made it Latest', () => {
    const justPublished = rel({ id: 42, tag_name: 'v2.6.5', prerelease: false })
    // `/releases/latest` answers with this very release — automatically.
    expect(shouldForcePrerelease(justPublished, justPublished, { publishedByThisRun: true })).toBe(true)
  })

  it('the same release, seen by a later manual re-run, is left alone', () => {
    // Same inputs minus the release event: now being Latest means a human
    // verified it, and demoting it would undo their flip.
    const verified = rel({ id: 42, tag_name: 'v2.6.5', prerelease: false })
    expect(shouldForcePrerelease(verified, verified, { publishedByThisRun: false })).toBe(false)
  })

  it('a prerelease this run published is already where it belongs', () => {
    const fresh = rel({ id: 43, prerelease: true })
    expect(shouldForcePrerelease(fresh, latest, { publishedByThisRun: true })).toBe(false)
  })

  it('a draft this run published is still left alone', () => {
    const draft = rel({ id: 44, draft: true })
    expect(shouldForcePrerelease(draft, latest, { publishedByThisRun: true })).toBe(false)
  })

  it('a release already marked prerelease needs nothing', () => {
    expect(shouldForcePrerelease(rel({ id: 4, prerelease: true }), latest)).toBe(false)
  })

  it('a draft is left alone', () => {
    expect(shouldForcePrerelease(rel({ id: 5, draft: true }), latest)).toBe(false)
  })

  it('the very first release of a repo, with no Latest to compare, is still held back', () => {
    expect(shouldForcePrerelease(rel({ id: 6, prerelease: false }), null)).toBe(true)
  })
})

describe('the workflow actually calls it', () => {
  const wf = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/release.yml'), 'utf8',
  )

  it('after the binaries are attached, not before', () => {
    expect(wf).toContain('enforce-prerelease:')
    expect(wf).toContain('needs: build-tauri')
    expect(wf).toContain('node scripts/enforce-prerelease.mjs')
  })

  it('with the tag from either trigger', () => {
    expect(wf).toContain('TAG: ${{ github.event.release.tag_name || github.event.inputs.tag }}')
  })

  it('and even when a platform of the matrix failed', () => {
    // A failed Linux lane must not leave a full release standing.
    const job = wf.slice(wf.indexOf('enforce-prerelease:'))
    expect(job).toContain('if: always()')
  })

  it('and knows whether a release event started the run', () => {
    // Without this the job cannot tell GitHub's automatic Latest pointer from
    // a human's deliberate flip, and falls back to doing nothing.
    expect(wf).toContain('PUBLISHED_TAG: ${{ github.event.release.tag_name }}')
  })
})

// The release path used to run no check at all: no tsc, no vitest, no cargo —
// whatever sat on master when someone clicked Publish became a signed installer.
describe('nothing is built before it is checked', () => {
  const wf = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/release.yml'), 'utf8',
  )

  it('the gate is CI itself, so a check added to CI cannot skip the release', () => {
    expect(wf).toContain('uses: ./.github/workflows/ci.yml')
  })

  it('and the build waits for it', () => {
    const job = wf.slice(wf.indexOf('build-tauri:'))
    expect(job).toContain('needs: gate')
  })

  it('the gate reads the tagged commit, not whatever the branch points at', () => {
    expect(wf).toContain("ref: ${{ github.event.release.tag_name || github.event.inputs.tag }}")
    // target_commitish is a BRANCH name: building it means the tag names one
    // commit and the signed installer contains another (AGPL-3.0 §6 as well).
    expect(wf).not.toContain('github.event.release.target_commitish')
  })
})

// The Rust suite existed for months while CI only type-checked it.
describe('CI runs the Rust tests it has', () => {
  const ci = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/ci.yml'), 'utf8',
  )

  it('cargo test, not just cargo check', () => {
    expect(ci).toContain('run: cargo test')
  })

  it('and is callable as a gate', () => {
    expect(ci).toContain('workflow_call:')
  })
})
