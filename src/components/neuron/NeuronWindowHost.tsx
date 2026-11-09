import { Suspense, lazy } from 'react'

// Neurons' window (3.1.0) in a chunk of its own, loaded once the plugin is
// on. A floating window has no place to hold while it loads, so nothing
// stands there meanwhile (the views' skeletons are for <main>).
const NeuronWindow = lazy(() => import('./NeuronWindow').then((m) => ({ default: m.NeuronWindow })))

export function NeuronWindowHost() {
  return (
    <Suspense fallback={null}>
      <NeuronWindow />
    </Suspense>
  )
}
