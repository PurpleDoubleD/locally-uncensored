import { describe, it, expect } from 'vitest'
import { cubeGlb, buildGlb } from '../glb-build'
import { loadGlb, allowedUrl, MeshLoadError, NOT_A_MODEL, COMPRESSED } from '../mesh-load'
import { exportObj, exportStl, exportMesh } from '../mesh-export'
import { factsLine, isGlb, requiredExtensions, trianglesText, bytesText, triangleCount, unsupportedCompression } from '../mesh-facts'

const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

describe('mesh facts', () => {
  it('counts triangles with and without an index', () => {
    expect(triangleCount([{ indexCount: 36, vertexCount: 8 }, { indexCount: null, vertexCount: 9 }])).toBe(15)
  })
  it('writes the line under the view', () => {
    expect(trianglesText(1)).toBe('1 triangle')
    expect(trianglesText(940)).toBe('940 triangles')
    expect(trianglesText(128_400)).toBe('128k triangles')
    expect(trianglesText(1_240_000)).toBe('1.2M triangles')
    expect(bytesText(14_200_000)).toBe('14 MB')
    expect(bytesText(820_000)).toBe('820 KB')
    expect(factsLine(128_000, 14_000_000)).toBe('128k triangles · 14 MB')
    expect(factsLine(12)).toBe('12 triangles')
  })
  it('knows a GLB by its first bytes', () => {
    expect(isGlb(cubeGlb())).toBe(true)
    expect(isGlb(new TextEncoder().encode('<html>not a model</html>'))).toBe(false)
    expect(isGlb(new Uint8Array([0x67, 0x6c, 0x54]))).toBe(false)
  })
  it('reads the required extensions', () => {
    const draco = cubeGlb({ extensionsRequired: ['KHR_draco_mesh_compression'] })
    expect(requiredExtensions(draco)).toEqual(['KHR_draco_mesh_compression'])
    expect(unsupportedCompression(draco)).toBe(true)
    expect(unsupportedCompression(cubeGlb())).toBe(false)
  })
})

describe('loadGlb', () => {
  it('parses the cube with its colours', async () => {
    const m = await loadGlb(ab(cubeGlb()))
    expect(m.triangles).toBe(12)
    expect(m.blockedUrls).toBe(0)
    let colors = 0
    m.root.traverse((o) => { const g = (o as { geometry?: { attributes: Record<string, unknown> } }).geometry; if (g?.attributes.color) colors += 1 })
    expect(colors).toBe(1)
  })
  it('refuses a file that is no GLB', async () => {
    await expect(loadGlb(ab(new TextEncoder().encode('just text, padded to be long')))).rejects.toThrow(NOT_A_MODEL)
  })
  it('refuses Draco and KTX2 with its own sentence', async () => {
    const e = await loadGlb(ab(cubeGlb({ extensionsRequired: ['KHR_texture_basisu'] }))).catch((x) => x)
    expect(e).toBeInstanceOf(MeshLoadError)
    expect(e.message).toBe(COMPRESSED)
  })
  it('never lets a model reach a foreign address', async () => {
    expect(allowedUrl('https://evil.example/x.png')).toBe(false)
    expect(allowedUrl('http://localhost/x.png')).toBe(false)
    expect(allowedUrl('file:///etc/passwd')).toBe(false)
    expect(allowedUrl('blob:http://x/1')).toBe(true)
    expect(allowedUrl('data:image/png;base64,AAAA')).toBe(true)
    const fetched: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (u: RequestInfo | URL) => { fetched.push(String(u)); throw new Error('no network in tests') }) as typeof fetch
    try {
      const glb = buildGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], externalImageUri: 'https://tracker.example/pixel.png' })
      const m = await loadGlb(ab(glb)).catch(() => null)
      expect(fetched.some((u) => u.includes('tracker.example'))).toBe(false)
      if (m) expect(m.blockedUrls).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = orig
    }
  })
})

describe('mesh export', () => {
  it('writes a valid OBJ and binary STL of the cube', async () => {
    const { root } = await loadGlb(ab(cubeGlb()))
    const obj = new TextDecoder().decode(exportObj(root))
    expect(obj.match(/^v /gm)?.length).toBe(8)
    expect(obj.match(/^f /gm)?.length).toBe(12)
    const stl = exportStl(root)
    // 80-byte header, a uint32 count, 50 bytes per triangle.
    expect(new DataView(stl.buffer, stl.byteOffset).getUint32(80, true)).toBe(12)
    expect(stl.byteLength).toBe(84 + 12 * 50)
  })
  it('hands the GLB back unchanged', async () => {
    const glb = cubeGlb()
    const { root } = await loadGlb(ab(glb))
    expect(await exportMesh('glb', root, glb)).toBe(glb)
  })
})
