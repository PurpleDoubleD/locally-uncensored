// The 3D view of Create: plain three, no React, so the desktop, the phone and
// lu-labs.ai draw a model the same way (C3D-PLAN 2.2).
//
// Drag turns, wheel or pinch zooms, right-drag or two fingers pan, a double
// click puts the view back. The light is three's RoomEnvironment, computed on
// the spot: an HDR preset would be fetched from a foreign server.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { loadGlb, disposeTree, type LoadedMesh } from './mesh-load'

export type MeshLook = 'color' | 'clay' | 'wireframe'
export type MeshBackdrop = 'dark' | 'light'

export interface MeshViewer {
  load(bytes: ArrayBuffer): Promise<LoadedMesh>
  setLook(look: MeshLook): void
  setBackdrop(backdrop: MeshBackdrop): void
  setAutoTurn(on: boolean): void
  reset(): void
  /** A still of what the view shows, as a JPEG data URL `size` pixels wide. */
  poster(size?: number): string | null
  /** The loaded model, for the exporters. */
  model(): THREE.Object3D | null
  dispose(): void
}

const BACKDROP: Record<MeshBackdrop, number> = { dark: 0x15161a, light: 0xeceef2 }

/** Whether this device can draw WebGL at all. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export function createMeshViewer(canvas: HTMLCanvasElement, opts: { onUserTouch?: () => void } = {}): MeshViewer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BACKDROP.dark)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  scene.environment = pmrem.fromScene(room, 0.04).texture
  room.dispose?.()

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.autoRotateSpeed = 1.2

  let current: LoadedMesh | null = null
  let originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  let look: MeshLook = 'color'
  let home = { pos: new THREE.Vector3(0, 0, 3), target: new THREE.Vector3() }
  let disposed = false
  const clay = new THREE.MeshStandardMaterial({ color: 0xbfb8ad, roughness: 0.85, metalness: 0 })
  const wire = new THREE.MeshBasicMaterial({ color: 0x9aa4b5, wireframe: true })

  const stopTurn = () => {
    if (controls.autoRotate) controls.autoRotate = false
    opts.onUserTouch?.()
  }
  controls.addEventListener('start', stopTurn)
  const onDouble = () => reset()
  canvas.addEventListener('dblclick', onDouble)

  const resize = () => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
  }
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
  observer?.observe(canvas)

  renderer.setAnimationLoop(() => {
    if (disposed) return
    resize()
    controls.update()
    renderer.render(scene, camera)
  })

  function frame(root: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    root.position.sub(center)
    const radius = Math.max(size.length() / 2, 1e-3)
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))
    camera.near = dist / 100
    camera.far = dist * 100
    camera.updateProjectionMatrix()
    home = { pos: new THREE.Vector3(dist * 0.55, dist * 0.35, dist * 0.8), target: new THREE.Vector3() }
    reset()
  }

  function applyLook() {
    if (!current) return
    current.root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const orig = originals.get(mesh)
      if (!orig) return
      mesh.material = look === 'color' ? orig : look === 'clay' ? clay : wire
    })
  }

  function reset() {
    camera.position.copy(home.pos)
    controls.target.copy(home.target)
    controls.update()
  }

  return {
    async load(bytes) {
      const next = await loadGlb(bytes)
      if (disposed) {
        disposeTree(next.root)
        return next
      }
      if (current) {
        scene.remove(current.root)
        disposeTree(current.root)
      }
      current = next
      originals = new Map()
      next.root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) originals.set(mesh, mesh.material)
      })
      scene.add(next.root)
      frame(next.root)
      applyLook()
      controls.autoRotate = true
      return next
    },
    setLook(next) {
      look = next
      applyLook()
    },
    setBackdrop(b) {
      ;(scene.background as THREE.Color).set(BACKDROP[b])
    },
    setAutoTurn(on) {
      controls.autoRotate = on
    },
    reset,
    poster(size = 384) {
      if (!current) return null
      renderer.render(scene, camera)
      const w = canvas.width, h = canvas.height
      if (!w || !h) return null
      const out = document.createElement('canvas')
      out.width = size
      out.height = Math.round((size * h) / w)
      const ctx = out.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(canvas, 0, 0, out.width, out.height)
      return out.toDataURL('image/jpeg', 0.82)
    },
    model: () => current?.root ?? null,
    dispose() {
      disposed = true
      renderer.setAnimationLoop(null)
      observer?.disconnect()
      canvas.removeEventListener('dblclick', onDouble)
      controls.removeEventListener('start', stopTurn)
      controls.dispose()
      if (current) disposeTree(current.root)
      clay.dispose()
      wire.dispose()
      scene.environment?.dispose()
      pmrem.dispose()
      renderer.dispose()
    },
  }
}
