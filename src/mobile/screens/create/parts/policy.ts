/**
 * The one place Create reads the store rules from: the scaffold module
 * src/mobile/policy/ (report sheet, consent sheet, switches).
 */
import type { GalleryItem } from '../../../../stores/createStore'
import { galleryLabelShort } from '../../../../lib/render/gallery-label'
import { isComputerItem } from './computer-media'
import { carriesUnfilteredWord, directMarkShown, ensureAiConsent, namesUnfiltered, openReport, shownName, storePolicy, unfilteredMarksShown, unfilteredWordsShown, type ShownName } from '../../../policy'

export { ensureAiConsent, openReport, storePolicy }
export type { ReportTarget, StorePolicy } from '../../../policy'

/** Report a result of the gallery. A result of the user's computer is reported as made outside the cloud. */
export function reportItem(item: GalleryItem): void {
  // The server's report kinds have no 3D yet (content_reports.kind): a model
  // goes as an image, and the excerpt says what it is.
  const kind = item.type === '3d' ? 'image' : item.type
  const excerpt = `${item.type === '3d' ? '3D model: ' : ''}${galleryLabelShort(item, 120)}`
  if (isComputerItem(item)) {
    openReport({ kind, id: item.id, model: item.model, source: 'local', origin: 'computer', excerpt })
    return
  }
  openReport({ kind, id: item.jobId ?? item.id, model: item.model, source: 'cloud', excerpt })
}

/** Run `start` once the user agreed that content goes to an AI service. On "no" nothing starts and nothing is cleared. */
export async function withAiConsent(start: () => void | Promise<void>): Promise<boolean> {
  if (!(await ensureAiConsent())) return false
  await start()
  return true
}

export type PurchaseView =
  /** A button may lead to plans. */
  | { mode: 'links' }
  /** A sentence about where plans are, without a link or button. */
  | { mode: 'text-only' }
  /** A neutral statement, no word about buying. */
  | { mode: 'none' }

export function purchaseView(): PurchaseView {
  const purchase = storePolicy().purchase
  // 'in-app' (round 17, in no preset) reads as 'none' here: Create links nowhere and names no other place to buy.
  return { mode: purchase === 'in-app' ? 'none' : purchase }
}

/**
 * A build without the unfiltered catalogue (store switch unfilteredCatalog)
 * does not list the Create models that are marked as answering without
 * refusals, in the model sheet and in the model choice of a preset step.
 * A build that may not show the words lists no model whose name carries one
 * of them, unless it has the mark "Direct" for such a model: then the model
 * is listed under its name without the word (policy/unfiltered.ts).
 */
export function offeredCreateModels<M extends { adult?: boolean; label?: string; id?: string }>(models: readonly M[]): M[] {
  const policy = storePolicy()
  // Without the catalogue also no model whose id says it under a neutral label.
  const listed = policy.unfilteredCatalog ? [...models] : models.filter((m) => m.adult !== true && !carriesUnfilteredWord(m.id))
  return unfilteredWordsShown(policy) || directMarkShown(policy) ? listed : listed.filter((m) => !namesUnfiltered(m.label))
}

/**
 * The name and the mark of a Create model as this build shows them. The
 * label of the catalogue is the name; the id is never one. In a store build a
 * word such a build may not show is taken out of the label, and the model
 * carries the mark "Direct" where the build has that mark.
 */
export function shownCreateModel(model: { id?: string; label: string; description?: string }): ShownName {
  return shownName(model.label, storePolicy(), { also: [model.id, model.description] })
}

/** The label alone. */
export function shownCreateLabel(label: string, id?: string): string {
  return shownCreateModel({ id, label }).name
}

/** The mark "No Filter" of a Create model is advertising: a store build shows none. */
export function createMarksShown(): boolean {
  return unfilteredMarksShown()
}

/** A build whose store rules cap the content policy does not offer the presets that run on models without refusals. */
export function adultPresetsAllowed(): boolean {
  return storePolicy().contentLevels === 'all'
}
