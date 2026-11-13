import { expect, test } from '@playwright/test'
test('explicit review survives reload and editing clears it', async ({ page }, testInfo) => {
  await page.goto('/e2e/memory-sensitive-proof.html')
  await page.getByRole('button', { name: 'Add Memory', exact: true }).click()
  await page.getByPlaceholder('What should I remember?').fill('Review proof')
  await page.getByPlaceholder('Details… (required)').fill('Synthetic review fact')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Source: manual', { exact: true })).toBeVisible()
  await expect(page.getByText('Not reviewed', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm reviewed' }).click()
  await expect(page.getByText(/^Reviewed:/)).toBeVisible()
  // The store writes to IndexedDB without waiting (lib/memory-persistence). A reload right after the click
  // could come before that write, and the entry came back "Not reviewed" (1 of a CI-like run without retries).
  // Reload only once the review is on disk: what the test proves is that a saved review survives.
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const open = indexedDB.open('locally-uncensored-store')
    open.onerror = () => resolve(false)
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains('kv')) { db.close(); return resolve(false) }
      const get = db.transaction('kv', 'readonly').objectStore('kv').get('locally-uncensored-memory')
      get.onerror = () => { db.close(); resolve(false) }
      get.onsuccess = () => { db.close(); resolve(typeof get.result === 'string' && get.result.includes('"confirmedAt"')) }
    }
  }))).toBe(true)
  await page.reload()
  await expect(page.getByText(/^Reviewed:/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('memory-review.png') })
  await page.getByRole('button', { name: 'Edit entry' }).click()
  await page.locator('textarea').fill('Updated review fact')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Not reviewed', { exact: true })).toBeVisible()
})
