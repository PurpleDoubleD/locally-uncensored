#!/usr/bin/env node
/**
 * Put the release this build belongs to back into prerelease, unless it is the
 * one someone has already flipped to Latest.
 *
 * release.yml asks tauri-action for `prerelease: true`, and on the workflow's
 * own primary trigger that input is ignored: tauri-action only passes the flag
 * to createRelease, and on `on: release: [published]` the release already
 * exists, so the action reuses it untouched. A release published as a full
 * release therefore became GitHub's `latest` the moment CI attached the
 * binaries, with the download routes and every installed updater following
 * within minutes. That is exactly the 2026-08-10 incident the comment in
 * release.yml describes as fixed.
 *
 * Idempotent, and it can never undo a deliberate flip. Note that "deliberate"
 * cannot be read off the Latest flag alone: GitHub points Latest at any full
 * release the moment it is published, so inside the run that published it, the
 * flag means nothing. PUBLISHED_TAG carries the tag from this run's
 * `release: published` event; when it names the release we are looking at, the
 * release was published seconds ago and cannot have been verified, so it goes
 * back to prerelease. Outside that case the Latest flag is a human's verdict
 * and is left alone.
 *
 * Usage: TAG=v2.6.5 [PUBLISHED_TAG=v2.6.5] node scripts/enforce-prerelease.mjs
 */

import { shouldForcePrerelease } from './release-rules.mjs'

const repo = process.env.GITHUB_REPOSITORY ?? 'PurpleDoubleD/locally-uncensored'
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const tag = process.env.TAG
if (!token) {
  console.error('GITHUB_TOKEN missing')
  process.exit(1)
}
if (!tag) {
  console.error('TAG missing')
  process.exit(1)
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'lu-enforce-prerelease',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

const rel = await api(`/releases/tags/${tag}`)
// A repo whose only release is this one has no `latest` to compare against.
const latest = await api('/releases/latest').catch(() => null)

// Empty unless a `release: published` event started this run, and then it is
// that release's tag — the one thing that distinguishes "GitHub flagged this
// Latest by itself, just now" from "a human flipped it after checking it".
const publishedByThisRun = !!process.env.PUBLISHED_TAG && process.env.PUBLISHED_TAG === tag

if (!shouldForcePrerelease(rel, latest, { publishedByThisRun })) {
  console.log(
    `${tag} needs nothing: prerelease=${rel.prerelease}, draft=${rel.draft}, ` +
      `isLatest=${rel.id === latest?.id}, publishedByThisRun=${publishedByThisRun}`,
  )
  process.exit(0)
}

await api(`/releases/${rel.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ prerelease: true, make_latest: 'false' }),
})
console.log(`${tag} was a full release and has been put back to prerelease. Flip it to Latest by hand once it is verified.`)
