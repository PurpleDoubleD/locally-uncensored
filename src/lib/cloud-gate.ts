/**
 * The model lists in the gate pop-up, for somebody without a usable account.
 *
 * The gate shows what the switch leads to: one dropdown each for Chat, Code
 * and Create, filled from the public catalogue of lu-labs.ai, the same lists
 * the pricing page prints. A model there is not usable yet. A click opens a
 * small window with the two ways in, a plan or a pack, each one button to the
 * checkout in the browser, and the clicked model is remembered so the app
 * lands on exactly that model once the account can use it.
 *
 * What each way buys ("about 3,000 images or 112 clips") is read from the
 * catalogue's `offers`, never typed here. Without an answer from the server
 * (offline, or a server that does not have the route yet) the lists come from
 * the snapshot next to this file and the window names no figure at all.
 *
 * Pure: no store, no network. The pop-up and its tests both read it.
 */
import seed from './cloud-gate-seed.json'
import { VRAM_WORKING_GB } from './vram-fit'
import { CHECKOUT_PACK, CHECKOUT_PLAN, checkoutStartUrl, type CloudGateOpener } from './cloud-links'

export type GateCategory = 'chat' | 'code' | 'create'
export type GateCreateKind = 'image' | 'video' | 'edit'
export const GATE_CREATE_KINDS: readonly GateCreateKind[] = ['image', 'video', 'edit']
export const GATE_CREATE_KIND_LABEL: Record<GateCreateKind, string> = { image: 'Image', video: 'Video', edit: 'Edit' }
export const GATE_CATEGORY_LABEL: Record<GateCategory, string> = { chat: 'Chat', code: 'Code', create: 'Create' }

export interface GateModel {
  id: string
  label: string
  /** Create only. */
  kind?: GateCreateKind
  /** Runs only with the content filter off; the row carries the app's
   *  measured mark, as in Create. */
  adult?: true
}

export interface GatePlanOffer {
  tier: string
  interval: 'month' | 'year'
  eur: number
  images: number
  clips: number
}

export interface GatePackOffer {
  id: string
  eur: number
  images: number
  clips: number
}

export interface GateCatalog {
  categories: Record<GateCategory, GateModel[]>
  /** Null when the lists come from the snapshot: no figure is shown then. */
  offers: { plans: GatePlanOffer[]; packs: GatePackOffer[] } | null
}

/** The id the checkout accepts as `model`, and the same the app sends with a
 *  turn or a job. Anything else is dropped on the way in. */
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,80}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function models(raw: unknown, create: boolean): GateModel[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: GateModel[] = []
  for (const m of raw) {
    if (!isObj(m) || typeof m.id !== 'string' || !MODEL_ID.test(m.id) || seen.has(m.id)) continue
    // The app's own name wins where the server sends one, as in the job
    // catalogue (api/cloud/catalog.ts).
    const name = [m.native_label, m.label].find((v): v is string => typeof v === 'string' && v.trim() !== '')
    const label = name?.trim() ?? m.id
    const adult = m.adult === true ? { adult: true as const } : {}
    if (create) {
      // A kind this build does not know is left out, so the server can add
      // one without an app that cannot show it.
      if (!GATE_CREATE_KINDS.includes(m.kind as GateCreateKind)) continue
      out.push({ id: m.id, label, kind: m.kind as GateCreateKind, ...adult })
    } else {
      out.push({ id: m.id, label, ...adult })
    }
    seen.add(m.id)
  }
  return out
}

function offers(raw: unknown): GateCatalog['offers'] {
  if (!isObj(raw) || !Array.isArray(raw.plans) || !Array.isArray(raw.packs)) return null
  const plans = raw.plans.filter((p): p is GatePlanOffer =>
    isObj(p) && typeof p.tier === 'string' && (p.interval === 'month' || p.interval === 'year')
    && isCount(p.eur) && isCount(p.images) && isCount(p.clips))
    .map(({ tier, interval, eur, images, clips }) => ({ tier, interval, eur, images, clips }))
  const packs = raw.packs.filter((p): p is GatePackOffer =>
    isObj(p) && typeof p.id === 'string' && isCount(p.eur) && isCount(p.images) && isCount(p.clips))
    .map(({ id, eur, images, clips }) => ({ id, eur, images, clips }))
  return { plans, packs }
}

/** The server's answer as the pop-up reads it, or null when it is not one. */
export function parseGateCatalog(raw: unknown): GateCatalog | null {
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.categories)) return null
  const c = raw.categories
  const out: GateCatalog = {
    categories: { chat: models(c.chat, false), code: models(c.code, false), create: models(c.create, true) },
    offers: offers(raw.offers),
  }
  return out.categories.chat.length > 0 ? out : null
}

/** The snapshot the app ships with, for a machine without an answer. */
export const GATE_SEED: GateCatalog = {
  categories: {
    chat: models(seed.chat, false),
    code: models(seed.code, false),
    create: models(seed.create, true),
  },
  offers: null,
}

export type GateWay = 'sub' | 'credits'

/** The one button of each way. The plan is the first plan, monthly; the pack
 *  the smallest one. */
export const GATE_DEFAULT_PLAN = CHECKOUT_PLAN
export const GATE_DEFAULT_PACK = CHECKOUT_PACK

/** The checkout in the browser. Signed out, the page signs in first and comes
 *  back on its own. Built by lib/cloud-links, which adds where the click came
 *  from (utm_medium=gate-models) and the app's own scheme for the way back. */
export function gateCheckoutUrl(base: string, way: GateWay, model: string, category: GateCategory, opener?: CloudGateOpener): string {
  return checkoutStartUrl({
    order: way === 'sub' ? 'sub' : 'pack',
    src: 'app-gate',
    medium: 'gate-models',
    opener,
    model,
    category,
    base,
  })
}

const count = (n: number) => n.toLocaleString('en-US')

/**
 * What one way buys, as results: "€19 a month, about 3,000 images or 112
 * clips". Read from the catalogue's offers; null when there is none, and then
 * the window names no figure.
 */
export function gateOfferLine(way: GateWay, offerList: GateCatalog['offers']): string | null {
  if (!offerList) return null
  if (way === 'sub') {
    const p = offerList.plans.find((o) => o.tier === GATE_DEFAULT_PLAN.tier && o.interval === GATE_DEFAULT_PLAN.interval)
    return p ? `€${count(p.eur)} a month, about ${count(p.images)} images or ${count(p.clips)} clips each month` : null
  }
  const k = offerList.packs.find((o) => o.id === GATE_DEFAULT_PACK)
  return k ? `€${count(k.eur)} once, about ${count(k.images)} images or ${count(k.clips)} clips` : null
}

/** The price of the pack the buttons sell, from the catalogue's offers. Null
 *  without an answer from the server: the app then names no pack price, as
 *  lib/cloud-pitch keeps no pack sizes (decision of 13.09.2026). */
export function gatePackEur(offerList: GateCatalog['offers']): number | null {
  const k = offerList?.packs.find((o) => o.id === GATE_DEFAULT_PACK)
  return k ? k.eur : null
}

/**
 * The parameter count a chat model's id names, in billions: "Qwen3-235B-A22B"
 * is 235, "gemma-4-31b-it" is 31. The first count is the total, the "A22B" of
 * a mixture of experts is what runs per token, not what has to be held. Null
 * when the id names none (most hosted flagships): such a model gets no mark,
 * because nothing says how big it is.
 */
export function paramsInId(id: string): number | null {
  const name = id.split('/').pop() ?? id
  const m = name.match(/(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?)[bB](?![A-Za-z])/)
  if (!m) return null
  const n = parseFloat(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Whether a chat model is too big for this machine to run itself: even at
 * 4 bits a weight (half a byte per parameter) plus the working memory every
 * run needs does not fit the memory a local model may use here (the card on
 * a PC, the model's share of the pool on a Mac, see shared-memory-wording).
 * Unknown memory or an unknown size: no mark.
 */
export function tooBigForThisMachine(id: string, budgetGb: number | null): boolean {
  const params = paramsInId(id)
  if (params === null || typeof budgetGb !== 'number' || budgetGb <= 0) return false
  return params * 0.5 + VRAM_WORKING_GB > budgetGb
}

export function tooBigLine(mac: boolean): string {
  return mac ? 'Runs in LU Cloud, too big for your Mac' : 'Runs in LU Cloud, too big for your GPU'
}

/** The model somebody clicked in the gate, kept until the account can use it. */
export interface GatePick {
  model: string
  category: GateCategory
  kind?: GateCreateKind
  at: number
}

/** A week: long enough for a checkout that waits on a bank, short enough that
 *  a forgotten click does not steer a sign in months later. */
export const GATE_PICK_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function freshGatePick(pick: GatePick | null | undefined, now: number): GatePick | null {
  if (!pick || typeof pick.model !== 'string' || !MODEL_ID.test(pick.model)) return null
  if (!(pick.category in GATE_CATEGORY_LABEL)) return null
  return now - pick.at >= 0 && now - pick.at < GATE_PICK_TTL_MS ? pick : null
}
