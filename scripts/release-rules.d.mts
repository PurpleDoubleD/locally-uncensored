/** Types for the plain-node rule module. The script itself runs in CI without
 *  a build step, so the implementation stays .mjs and the types live here. */

export declare const MARKER: string
export declare const BANNER: string

export interface GitHubRelease {
  id: number
  tag_name?: string
  prerelease?: boolean
  draft?: boolean
  published_at?: string | null
  created_at?: string | null
  body?: string | null
}

export declare function withoutBanner(body: string | null | undefined): string
export declare function shouldCarryBanner(
  rel: GitHubRelease,
  latest: GitHubRelease | null | undefined,
): boolean

export interface ForcePrereleaseContext {
  /** True when this run's own `release: published` event named this release —
   *  it was published seconds ago, so it cannot have been verified yet. */
  publishedByThisRun?: boolean
}

export declare function shouldForcePrerelease(
  rel: GitHubRelease | null | undefined,
  latest: GitHubRelease | null | undefined,
  ctx?: ForcePrereleaseContext,
): boolean
