/**
 * Split GGUF sets (`<name>-00001-of-00003.gguf`): llama.cpp loads a split set
 * only when every part lies next to the first one. A repository whose uploader
 * is still uploading lists some parts only, and a download of those is many
 * gigabytes of a model that never starts.
 */

// 5-digit llama.cpp split convention, a few uploaders pad to 4.
const SHARD_RE = /-(\d{4,5})-of-(\d{4,5})\.gguf$/i

/** How many parts of a split set are there, and how many it needs. */
export interface ShardGap { have: number; of: number }

/**
 * The paths of one file group: null when it can be loaded (a single file, or
 * exactly the parts 1..N of "-of-N", each once), otherwise how many of the
 * parts are there.
 */
export function shardSetGap(paths: readonly string[]): ShardGap | null {
  const shards = paths.map((p) => SHARD_RE.exec(p))
  if (shards.every((m) => !m)) return null
  const of = Math.max(...shards.map((m) => (m ? parseInt(m[2], 10) : 0)))
  const indices = new Set(
    shards
      .filter((m): m is RegExpExecArray => !!m && parseInt(m[2], 10) === of)
      .map((m) => parseInt(m[1], 10))
      .filter((i) => i >= 1 && i <= of),
  )
  const have = indices.size
  return have === of && paths.length === of ? null : { have, of }
}
