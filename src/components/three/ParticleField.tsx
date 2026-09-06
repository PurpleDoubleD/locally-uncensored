import { useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * The field used to read a `particleDensity` setting and index a
 * `PARTICLE_COUNTS` table with it. Neither exists any more: `Settings` has no
 * density key and `lib/constants` exports no such table, so the lookup was
 * `undefined[undefined]` — a TypeError on the first render of this component,
 * masked only by the fact that nothing mounts ParticleBackground today.
 * The count is the value the old `|| 3000` fallback would have produced.
 */
const PARTICLE_COUNT = 3000

/**
 * One field's worth of particles: a random point on a shell between r=3 and
 * r=7, a random grey, a random size.
 *
 * Random, and that is the point — but the randomness may not happen while the
 * component renders. React is free to render a component more than once for
 * one commit, and a re-run here would silently mint a SECOND set of buffers
 * while the geometry below still holds the first: the animation loop would
 * then read its rest positions out of one array and write its frames into
 * another, and the field would freeze mid-motion. Hence a plain function,
 * called once per mount from a lazy state initialiser.
 */
function makeParticles(count: number) {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const sizes = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const i3 = i * 3
    // Sphere distribution
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 3 + Math.random() * 4

    positions[i3] = r * Math.sin(phi) * Math.cos(theta)
    positions[i3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i3 + 2] = r * Math.cos(phi)

    // Subtle white/gray
    const brightness = 0.3 + Math.random() * 0.4
    colors[i3] = brightness
    colors[i3 + 1] = brightness
    colors[i3 + 2] = brightness + Math.random() * 0.1

    sizes[i] = 1.5 + Math.random() * 2
  }

  return { positions, colors, sizes }
}

export function ParticleField() {
  const pointsRef = useRef<THREE.Points>(null)
  const mouseRef = useRef(new THREE.Vector2(0, 0))
  const { viewport } = useThree()

  const count = PARTICLE_COUNT

  // A lazy state initialiser, NOT useMemo: useMemo is a hint React may throw
  // away and recompute, which for this component means brand-new buffers under
  // a running animation. State is a guarantee — these three arrays are created
  // once per mounted field and stay the ones the geometry was built from.
  const [{ positions, colors, sizes }] = useState(() => makeParticles(count))

  useFrame(({ clock, pointer }) => {
    if (!pointsRef.current) return

    mouseRef.current.lerp(
      new THREE.Vector2(pointer.x * viewport.width * 0.5, pointer.y * viewport.height * 0.5),
      0.05
    )

    const time = clock.getElapsedTime()
    pointsRef.current.rotation.y = time * 0.02
    pointsRef.current.rotation.x = Math.sin(time * 0.01) * 0.1

    const posArray = pointsRef.current.geometry.attributes.position.array as Float32Array
    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      const ox = positions[i3]
      const oy = positions[i3 + 1]

      // Gentle wave motion
      posArray[i3] = ox + Math.sin(time * 0.3 + i * 0.01) * 0.1
      posArray[i3 + 1] = oy + Math.cos(time * 0.2 + i * 0.015) * 0.1

      // Mouse repulsion
      const dx = posArray[i3] - mouseRef.current.x
      const dy = posArray[i3 + 1] - mouseRef.current.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 2) {
        const force = (2 - dist) * 0.3
        posArray[i3] += (dx / dist) * force * 0.1
        posArray[i3 + 1] += (dy / dist) * force * 0.1
      }
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true
  })

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        <bufferAttribute attach="attributes-size" args={[sizes, 1]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.03}
        vertexColors
        transparent
        opacity={0.6}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}
