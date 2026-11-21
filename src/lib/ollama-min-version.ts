// Some Ollama models name the server version they need (`requires` in the
// manifest config). An older server only fails once the pull is under way, so
// the catalog entry carries the same number and the Get says it first.

interface ParsedVersion {
  parts: [number, number, number]
  prerelease: boolean
}

function parseVersion(version: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version.trim())
  if (!m) return null
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: Boolean(m[4]) }
}

/**
 * True when `version` is older than `minimum`. A release candidate counts as
 * older than its release. A version that cannot be read, and the 0.0.0 of a
 * self-built Ollama, say nothing about its age and are never called too old.
 */
export function isOllamaOlderThan(version: string | null | undefined, minimum: string): boolean {
  if (!version) return false
  const have = parseVersion(version)
  const need = parseVersion(minimum)
  if (!have || !need || have.parts.every((p) => p === 0)) return false
  for (let i = 0; i < 3; i++) {
    if (have.parts[i] !== need.parts[i]) return have.parts[i] < need.parts[i]
  }
  return have.prerelease && !need.prerelease
}

/** The sentence a Get shows instead of a pull that cannot work, or null. */
export function ollamaVersionBlock(
  model: { name: string; minOllama?: string },
  version: string | null | undefined,
): string | null {
  if (!model.minOllama || !isOllamaOlderThan(version, model.minOllama)) return null
  return `${model.name} needs Ollama ${model.minOllama} or newer. This Ollama is ${version}. Update Ollama, then press Get again.`
}
