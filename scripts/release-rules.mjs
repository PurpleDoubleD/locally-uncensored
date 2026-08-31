/**
 * The rules about release state that CI applies, in one testable place.
 *
 * Both callers are top-level-await programs that talk to the GitHub API on
 * import, so the part that can be wrong quietly lives here instead, where a
 * test can reach it without a token.
 */

export const MARKER = '<!-- lu-old-release-banner -->'

export const BANNER =
  MARKER +
  '\n> **This is an old release.** Get the current version from the ' +
  '[latest release](https://github.com/PurpleDoubleD/locally-uncensored/releases/latest), ' +
  'or download the Windows installer straight from ' +
  '[lu-labs.ai](https://lu-labs.ai/api/download/windows). ' +
  'Older builds miss fixes and features, and some of them predate the Cloud.\n\n'

/** Strips a banner wherever it sits, so re-running never stacks them. */
export function withoutBanner(body) {
  const at = (body ?? '').indexOf(MARKER)
  if (at < 0) return body ?? ''
  const end = (body ?? '').indexOf('\n\n', at)
  return end < 0 ? '' : (body ?? '').slice(0, at) + (body ?? '').slice(end + 2)
}

const stamp = (rel) => Date.parse(rel?.published_at ?? rel?.created_at ?? '') || 0

/**
 * True when this release should carry the banner.
 *
 * `/releases/latest` is the release flagged Latest, which is a deliberate
 * choice (we publish as a prerelease and flip it once verified), not simply the
 * newest. So "not Latest" is NOT the same as "old": a release we published
 * five minutes ago is not Latest yet either, and the old rule stamped it "This
 * is an old release" the moment it appeared. The Discord announcement then
 * quotes that body, so the release everyone was waiting for announced itself as
 * obsolete (review 2026-08-14).
 *
 * A prerelease or draft that is at least as new as the current Latest is the
 * upcoming one and stays clean. Everything older still gets the banner,
 * including a prerelease that was superseded, because that one really is old.
 */
export function shouldCarryBanner(rel, latest) {
  if (!latest || rel.id === latest.id) return false
  const upcoming = (rel.prerelease === true || rel.draft === true) && stamp(rel) >= stamp(latest)
  return !upcoming
}

/**
 * True when this release must be forced back to prerelease.
 *
 * release.yml passes `prerelease: true` to tauri-action, and on the workflow's
 * OWN primary trigger that input does nothing. tauri-action only passes
 * draft/prerelease to createRelease (src/create-release.ts): when the release
 * already exists, which it always does on `on: release: [published]`, the
 * action reuses it and never patches the flag. So the guarantee written into
 * that comment ("a build is not a decision") held for workflow_dispatch and
 * for nothing else, and a release published as a full release went straight to
 * Latest with the download routes and every updater following within minutes.
 * That is the 2026-08-10 incident the comment says was fixed.
 *
 * The question this answers is "has a human verified this release?", NOT "is it
 * already Latest". Those look the same and are not: GitHub moves the Latest
 * pointer to any published full release BY ITSELF, immediately, with nobody
 * deciding anything. So the first version of this rule — `rel.id === latest.id
 * -> leave it alone` — was a guaranteed no-op in exactly the case it was
 * written for: a release published as a full release IS already Latest by the
 * time this job runs, the guard fired, and the release nobody had opened kept
 * the Latest flag and the updater traffic that comes with it.
 *
 * Verification happens on a real machine AFTER this build produced installers,
 * so nothing this run publishes can be verified yet: `publishedByThisRun` (the
 * `release: published` event that started this run names this same release)
 * means force it back, whatever the Latest pointer says.
 *
 * The deliberate flip stays safe: on a manual re-run over some older tag no
 * release event named it, `publishedByThisRun` is false, and a release that is
 * the flagged Latest is left alone — that flag is then a human's verdict.
 *
 * @param {object|null|undefined} rel    the release this build belongs to
 * @param {object|null|undefined} latest `/releases/latest`, or null if none
 * @param {{publishedByThisRun?: boolean}} [ctx] run context, see above
 */
export function shouldForcePrerelease(rel, latest, ctx = {}) {
  if (!rel || rel.prerelease === true || rel.draft === true) return false
  // Published by the event that started this run: not verified, by definition.
  if (ctx.publishedByThisRun === true) return true
  // Otherwise the Latest flag is somebody's deliberate choice — never undo it.
  if (latest && rel.id === latest.id) return false
  return true
}
