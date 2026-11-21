/**
 * The update hint of the open Android package.
 *
 * Run: npx vitest run src/mobile/lib/__tests__/app-update.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const call = vi.hoisted(() => vi.fn())
vi.mock('../../../api/backend', () => ({ backendCall: call }))

import { __resetAppUpdateForTests, checkDue, checkForUpdate, isNewer, parseVersion, readRelease, shownUpdate, updateHintOffered, UPDATE_EVERY_MS, useAppUpdate } from '../app-update'

const url = 'https://github.com/PurpleDoubleD/locally-uncensored/releases/download/v3.1.3/LU-3.1.3-Android.apk'
const digest = `sha256:${'a'.repeat(64)}`
const release = (over: Record<string, unknown> = {}) => ({ tag: 'v3.1.3', draft: false, prerelease: false, assets: [{ name: 'LU-3.1.3-Android.apk', digest, url }], ...over })

beforeEach(() => {
  call.mockReset()
  __resetAppUpdateForTests()
})

describe('versions', () => {
  it('compares numbers, not text', () => {
    expect(isNewer('3.1.10', '3.1.9')).toBe(true)
    expect(isNewer('v3.1.3', '3.0.7')).toBe(true)
    expect(isNewer('3.1.3', '3.1.3')).toBe(false)
    expect(isNewer('3.0.7', '3.1.3')).toBe(false)
  })
  it('a prerelease name or nonsense is no version', () => {
    expect(parseVersion('3.2.0-beta.1')).toBeNull()
    expect(isNewer('3.2.0-rc1', '3.1.3')).toBe(false)
    expect(isNewer(undefined, '3.1.3')).toBe(false)
  })
})

describe('the answer of GitHub', () => {
  it('reads version, address and checksum', () => {
    expect(readRelease(release())).toEqual({ version: '3.1.3', url, sha256: 'a'.repeat(64) })
  })
  it('a draft, a prerelease or a release without the APK is no update', () => {
    expect(readRelease(release({ draft: true }))).toBeNull()
    expect(readRelease(release({ prerelease: true }))).toBeNull()
    expect(readRelease(release({ prerelease: undefined }))).toBeNull()
    expect(readRelease(release({ assets: [] }))).toBeNull()
  })
  it('an APK at any other address is refused', () => {
    expect(readRelease(release({ assets: [{ name: 'LU-3.1.3-Android.apk', digest, url: 'https://example.com/LU-3.1.3-Android.apk' }] }))).toBeNull()
    expect(readRelease(release({ assets: [{ name: 'LU-3.1.3-Android.apk', digest, url: url.replace('PurpleDoubleD', 'Someone') }] }))).toBeNull()
  })
})

describe('who gets it and how often', () => {
  it('only the open package on Android', () => {
    expect(updateHintOffered('open', 'android')).toBe(true)
    expect(updateHintOffered('play', 'android')).toBe(false)
    expect(updateHintOffered('appstore', 'ios')).toBe(false)
    expect(updateHintOffered('open', 'ios')).toBe(false)
  })
  it('at most once a day', async () => {
    call.mockResolvedValue(release())
    const t = 1_800_000_000_000
    await checkForUpdate(t)
    await checkForUpdate(t + UPDATE_EVERY_MS - 1)
    expect(call).toHaveBeenCalledTimes(1)
    await checkForUpdate(t + UPDATE_EVERY_MS)
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenCalledWith('app_latest_release')
    expect(checkDue(t, t - 1)).toBe(true)
  })
  it('a failed check is asked again and keeps what was known', async () => {
    call.mockRejectedValueOnce(new Error('offline'))
    await checkForUpdate(1000)
    expect(useAppUpdate.getState().checkedAt).toBe(0)
    call.mockResolvedValueOnce(release())
    await checkForUpdate(2000)
    expect(useAppUpdate.getState().latest?.version).toBe('3.1.3')
  })
  it('a stored update is gone once it is installed', () => {
    const u = { version: '3.1.3', url, sha256: null }
    expect(shownUpdate(u, '3.1.2')).toBe(u)
    expect(shownUpdate(u, '3.1.3')).toBeNull()
  })
})
