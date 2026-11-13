// What the 3D view says about a model under the picture ("128k triangles ·
// 14 MB"), and the limits above which it asks before it draws one. Pure, so
// the numbers are tested without a canvas.

/** One mesh as the facts read it: the number of indices of its geometry (null
 *  for a geometry without an index) and its number of vertices. */
export interface MeshShape {
  indexCount: number | null
  vertexCount: number
}

/** Triangles of a set of meshes. A geometry without an index draws its
 *  vertices three by three. */
export function triangleCount(meshes: readonly MeshShape[]): number {
  let n = 0
  for (const m of meshes) n += Math.floor((m.indexCount ?? m.vertexCount) / 3)
  return n
}

/** "128k triangles", "1.2M triangles", "940 triangles". */
export function trianglesText(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M triangles`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k triangles`
  return `${n} ${n === 1 ? 'triangle' : 'triangles'}`
}

/** "14 MB", "820 KB". */
export function bytesText(bytes: number): string {
  if (bytes >= 1_000_000) return `${trim(bytes / 1_000_000)} MB`
  return `${Math.max(1, Math.round(bytes / 1_000))} KB`
}

/** The line under the view. Bytes are left out when they are not known. */
export function factsLine(triangles: number, bytes?: number): string {
  return bytes && bytes > 0 ? `${trianglesText(triangles)} · ${bytesText(bytes)}` : trianglesText(triangles)
}

function trim(v: number): string {
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')
}

/** Above these the view asks before it loads (C3D-PLAN 1.3): a file this
 *  large can stall a phone or a small laptop for seconds. */
export const HEAVY_BYTES = 150_000_000
export const HEAVY_TRIANGLES = 5_000_000

/** Whether a file is too large to draw without asking first. */
export function isHeavyFile(bytes: number): boolean {
  return bytes > HEAVY_BYTES
}

/** The first four bytes of every binary glTF. A file without them is no GLB,
 *  whatever its name says. */
export function isGlb(bytes: ArrayBuffer | Uint8Array): boolean {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return b.length >= 12 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46
}

/** The extensions a GLB says it needs, read from its JSON chunk without
 *  parsing the rest. Used to name Draco and KTX2 files the view cannot draw. */
export function requiredExtensions(bytes: ArrayBuffer | Uint8Array): string[] {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!isGlb(b) || b.length < 20) return []
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const length = view.getUint32(12, true)
  const type = view.getUint32(16, true)
  if (type !== 0x4e4f534a || 20 + length > b.length) return []
  try {
    const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + length))) as { extensionsRequired?: unknown }
    return Array.isArray(json.extensionsRequired) ? json.extensionsRequired.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}

/** Compression the view cannot unpack in v1: both need a worker the app's
 *  content policy does not allow (C3D-PLAN 1.3). */
export const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['KHR_draco_mesh_compression', 'KHR_texture_basisu'])

export function unsupportedCompression(bytes: ArrayBuffer | Uint8Array): boolean {
  return requiredExtensions(bytes).some((e) => UNSUPPORTED_EXTENSIONS.has(e))
}
