import { useRef, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useSettingsStore } from '../../stores/settingsStore'
import { PARTICLE_COUNTS } from '../../lib/constants'

export function ParticleField() {
  const pointsRef = useRef<THREE.Points>(null)
  const mouseRef = useRef(new THREE.Vector2(0, 0))
  const { viewport } = useThree()

  const particleDensity = useSettingsStore((s) => s.settings.particleDensity)
  const count = PARTICLE_COUNTS[particleDensity] || 3000

  const { positions, colors, sizes } = useMemo(() => {
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
  }, [count])

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
