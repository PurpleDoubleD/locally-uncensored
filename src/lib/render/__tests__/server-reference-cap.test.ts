/**
 * W6-API (30.10.2026): the catalogue names how many pictures the server takes
 * for a Studio reference model (`reference_images`, the start image counted).
 * The reference strip never offers more than that, and without the field it
 * stays at the provider schema, as before.
 *
 * Run: npx vitest run src/lib/render/__tests__/server-reference-cap.test.ts
 */
import { describe, expect, it } from 'vitest'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { neuerServer } from './fixtures/test-catalogs'
import { cloudReferenceCap, cloudTakesEndImage, studioExtraPhotoSlots } from '../create-studio'

const withField = (id: string, extra: Record<string, unknown>) =>
  useCloudCatalogStore.setState({ models: neuerServer().map((m) => (m.id === id ? { ...m, ...extra } : m)) })

describe('the server names the cap', () => {
  it('three pictures in all leave two further slots', () => {
    withField('wan-3.0-ref', { reference_images: 3 })
    expect(cloudReferenceCap('wan-3.0-ref')).toBe(3)
    expect(studioExtraPhotoSlots('wan-3.0-ref')).toBe(2)
  })
  it('a larger server cap never lifts the app limit of five photos', () => {
    withField('wan-3.0-ref', { reference_images: 10 })
    expect(studioExtraPhotoSlots('wan-3.0-ref')).toBe(4)
  })
  it('without the field the strip is as before', () => {
    useCloudCatalogStore.setState({ models: neuerServer() })
    expect(cloudReferenceCap('wan-3.0-ref')).toBe(0)
    expect(studioExtraPhotoSlots('wan-3.0-ref')).toBe(4)
  })
  it('end_image is read from the catalogue only', () => {
    useCloudCatalogStore.setState({ models: neuerServer() })
    expect(cloudTakesEndImage('wan-3.0')).toBe(false)
    withField('wan-3.0', { end_image: true })
    expect(cloudTakesEndImage('wan-3.0')).toBe(true)
  })
})
