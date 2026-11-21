/**
 * How each installed local media model stands on the user's graphics card, for
 * the model picker in Create and for the waiting area.
 *
 * The verdict is the catalogue's wherever the catalogue knows the file (a
 * bundle lists it, lib/vram-fit reads the bundle). A file no bundle names, or
 * one two bundles disagree about, is judged by its own size on the disk
 * against the card. Without a detected card (a Mac, or no vendor tool) every
 * answer is 'unknown' and nothing is asked of the disk.
 */
import { useEffect, useMemo, useState } from 'react'
import { useGraphicsCardGb } from './useGraphicsMemory'
import { readModelDiskSizes, type ClassifiedModel } from '../api/comfyui'
import {
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles, getRetiredBundles,
} from '../api/model-bundles'
import { needForInstalledFile, vramFit, fileVramFit, type VramFit } from '../lib/vram-fit'

const GIB = 1_073_741_824

let catalogue: ReturnType<typeof getImageBundles> | null = null
function allBundles() {
  catalogue ??= [
    ...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles(), ...getUpscaleBundles(), ...getRetiredBundles(),
  ]
  return catalogue
}

export interface LocalModelFits {
  /** The detected card in GB, null when there is none to name. */
  cardGb: number | null
  fitOf: (name: string) => VramFit
}

export function useLocalModelFits(models: readonly ClassifiedModel[]): LocalModelFits {
  const cardGb = useGraphicsCardGb()
  const [diskGb, setDiskGb] = useState<Record<string, number>>({})

  // Only the files the catalogue cannot answer for are weighed.
  const unknown = useMemo(
    () => (cardGb === null ? [] : models.filter((m) => !needForInstalledFile(m.name, allBundles()))),
    [models, cardGb],
  )
  const unknownKey = unknown.map((m) => m.name).join('\n')
  useEffect(() => {
    if (unknown.length === 0) return
    let alive = true
    void readModelDiskSizes([...unknown]).then((sizes) => {
      if (!alive || sizes.size === 0) return
      setDiskGb((prev) => {
        const next = { ...prev }
        for (const [name, bytes] of sizes) next[name] = bytes / GIB
        return next
      })
    })
    return () => { alive = false }
    // The list is a new array on every store update; its names are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknownKey])

  return useMemo(() => ({
    cardGb,
    fitOf: (name: string): VramFit => {
      if (cardGb === null) return 'unknown'
      const need = needForInstalledFile(name, allBundles())
      return need ? vramFit(need, cardGb) : fileVramFit(diskGb[name], cardGb)
    },
  }), [cardGb, diskGb])
}
