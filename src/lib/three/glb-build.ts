// A small binary glTF written by hand: one mesh with positions, an index and
// a colour per vertex. The tests parse it, and the stand-ins hand it out as a
// finished model. No exporter, no DOM: the bytes are laid out as the glTF 2.0
// spec names them (12-byte header, a JSON chunk, a BIN chunk, each padded to
// four bytes).

export interface GlbMesh {
  positions: number[]
  indices: number[]
  /** RGB from 0 to 1, three per vertex. */
  colors?: number[]
  /** glTF extensions the file says it requires (for tests of the refusals). */
  extensionsRequired?: string[]
  /** An image the file points at by address (for the URL filter's tests). */
  externalImageUri?: string
}

const pad4 = (n: number) => (n + 3) & ~3

export function buildGlb(mesh: GlbMesh): Uint8Array {
  const pos = new Float32Array(mesh.positions)
  const idx = new Uint16Array(mesh.indices)
  const col = mesh.colors ? new Float32Array(mesh.colors) : null
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k])
      max[k] = Math.max(max[k], pos[i + k])
    }
  }
  const posOff = 0
  const idxOff = pad4(pos.byteLength)
  const colOff = pad4(idxOff + idx.byteLength)
  const binLength = pad4(col ? colOff + col.byteLength : idxOff + idx.byteLength)
  const bin = new Uint8Array(binLength)
  bin.set(new Uint8Array(pos.buffer), posOff)
  bin.set(new Uint8Array(idx.buffer), idxOff)
  if (col) bin.set(new Uint8Array(col.buffer), colOff)

  const bufferViews: object[] = [
    { buffer: 0, byteOffset: posOff, byteLength: pos.byteLength, target: 34962 },
    { buffer: 0, byteOffset: idxOff, byteLength: idx.byteLength, target: 34963 },
  ]
  const accessors: object[] = [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
  ]
  const attributes: Record<string, number> = { POSITION: 0 }
  if (col) {
    bufferViews.push({ buffer: 0, byteOffset: colOff, byteLength: col.byteLength, target: 34962 })
    accessors.push({ bufferView: 2, componentType: 5126, count: col.length / 3, type: 'VEC3' })
    attributes.COLOR_0 = 2
  }
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'LU test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: binLength }],
    bufferViews,
    accessors,
  }
  if (mesh.extensionsRequired?.length) {
    json.extensionsUsed = mesh.extensionsRequired
    json.extensionsRequired = mesh.extensionsRequired
  }
  if (mesh.externalImageUri) {
    json.images = [{ uri: mesh.externalImageUri }]
    json.textures = [{ source: 0 }]
    ;(json.materials as Array<{ pbrMetallicRoughness: Record<string, unknown> }>)[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }
    ;(json.meshes as Array<{ primitives: Array<{ attributes: Record<string, number> }> }>)[0].primitives[0].attributes.TEXCOORD_0 = 0
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = pad4(jsonBytes.length)
  const total = 12 + 8 + jsonLength + 8 + binLength
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x46546c67, true) // "glTF"
  v.setUint32(4, 2, true)
  v.setUint32(8, total, true)
  v.setUint32(12, jsonLength, true)
  v.setUint32(16, 0x4e4f534a, true) // "JSON"
  out.fill(0x20, 20, 20 + jsonLength)
  out.set(jsonBytes, 20)
  v.setUint32(20 + jsonLength, binLength, true)
  v.setUint32(24 + jsonLength, 0x004e4942, true) // "BIN\0"
  out.set(bin, 28 + jsonLength)
  return out
}

/** A unit cube with a colour per corner: 8 vertices, 12 triangles. */
export function cubeGlb(extra: Partial<GlbMesh> = {}): Uint8Array {
  const positions = [
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]
  const colors = [
    0.9, 0.3, 0.2, 0.9, 0.6, 0.2, 0.9, 0.9, 0.2, 0.3, 0.9, 0.2,
    0.2, 0.9, 0.6, 0.2, 0.6, 0.9, 0.4, 0.2, 0.9, 0.8, 0.2, 0.9,
  ]
  return buildGlb({ positions, indices, colors, ...extra })
}
