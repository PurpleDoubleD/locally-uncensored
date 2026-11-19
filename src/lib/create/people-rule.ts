// ONE rule for the people of a swap, on every model (David, 19.11.2026; the
// real test of H3 with two people, uebergabe-310/H3-ZWEI-PERSONEN). Pure: no
// React, no store.
//
//   Every person is one row: a number, where they are, which character.
//   Tapping in the first frame sets number and place. Whoever is not in the
//   first frame yet gets "comes in later from the left/right".
//   Each model only gets its own form of the rows: H3 a sentence, SCAIL-2 and
//   Kling the tap as a point, OpenJutsu a role text, the local way a mask.
//   What a model cannot do stands at the row or at Create, with a model that
//   can. The model is never changed without a click.
//
// The written form of this rule for the web: uebergabe-310/313-CHARACTER/PERSONEN-REGEL.md.

import {
  swapMarkRoles, SWAP_KLING_MODEL, SWAP_LONG_MODEL, SWAP_MAIN_MODEL, SWAP_OPENJUTSU_MODEL, type SwapMark,
} from '../render/swap'

/** The local way of Swap: Wan 2.2 Animate in ComfyUI, mode replace. Not a
 *  cloud id; the run takes the picked local Animate model. */
export const SWAP_LOCAL_MODEL = 'local:wan-animate-replace'

/** The two ways of H3 (web only for now; here so the rule is one). */
export const SWAP_H3_SINGULARITY = 'minimax-h3-singularity'
export const SWAP_H3_VIDEO_EDIT = 'minimax-h3-video-edit'

export type LaterSide = 'left' | 'right'

/** A person as the rule sees them. */
export interface PersonRow {
  /** Where they were tapped in the first frame (0 to 1). */
  mark?: SwapMark | null
  /** Not in the first frame: comes in later from this side. */
  later?: LaterSide | null
  /** The character or photo is set. */
  filled?: boolean
}

/** How a model is told who is who. */
export type PeopleForm = 'sentence' | 'point' | 'roles' | 'main' | 'mask'

export interface SwapModelCan {
  /** Name as the panel writes it. */
  name: string
  /** People in one run. */
  people: number
  /** A person who walks in later can be named. */
  later: boolean
  /** Seconds of video the model reads (the rest is cut, said in the panel). */
  maxSeconds: number
  form: PeopleForm
  /** Runs on this computer. */
  local: boolean
}

/** What each model can, from real runs only (13./14.11. SCAIL-2 and Kling,
 *  18.11. H3 with 2 people and a late entry). Untested stays "no". */
export const SWAP_CAN: Record<string, SwapModelCan> = {
  [SWAP_MAIN_MODEL]: { name: 'SCAIL-2', people: 3, later: false, maxSeconds: 120, form: 'point', local: false },
  [SWAP_KLING_MODEL]: { name: 'Kling 3.0 Pro', people: 1, later: false, maxSeconds: 30, form: 'point', local: false },
  [SWAP_OPENJUTSU_MODEL]: { name: 'OpenJutsu', people: 4, later: false, maxSeconds: 15, form: 'roles', local: false },
  [SWAP_LONG_MODEL]: { name: 'Wan 2.2 Animate', people: 1, later: false, maxSeconds: 120, form: 'main', local: false },
  [SWAP_H3_SINGULARITY]: { name: 'MiniMax H3 Singularity', people: 2, later: true, maxSeconds: 15, form: 'sentence', local: false },
  [SWAP_H3_VIDEO_EDIT]: { name: 'MiniMax H3 Video Edit', people: 2, later: true, maxSeconds: 15, form: 'sentence', local: false },
  [SWAP_LOCAL_MODEL]: { name: 'Local (Wan 2.2 Animate)', people: 1, later: false, maxSeconds: 5, form: 'mask', local: true },
}

/** The order in which a model is recommended. */
export const SWAP_RECOMMEND_ORDER: readonly string[] = [
  SWAP_MAIN_MODEL, SWAP_H3_VIDEO_EDIT, SWAP_H3_SINGULARITY, SWAP_OPENJUTSU_MODEL, SWAP_KLING_MODEL, SWAP_LONG_MODEL, SWAP_LOCAL_MODEL,
]

export function swapCan(model: string): SwapModelCan {
  return SWAP_CAN[model] ?? { name: model, people: 1, later: false, maxSeconds: 120, form: 'main', local: false }
}

/** The place of every row as words, in the order of the rows: from the taps
 *  (left, in the middle, right), "the person who walks in later from the
 *  left", or "the person" for one row without either. */
export function personPlaces(rows: readonly PersonRow[]): string[] {
  const marked = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.mark && !r.later)
  const placed = swapMarkRoles(marked.map(({ r }) => r.mark!))
  const byIndex = new Map(marked.map(({ i }, k) => [i, placed[k]]))
  return rows.map((r, i) => {
    if (r.later) return `the person who walks in later from the ${r.later}`
    return byIndex.get(i) ?? (rows.length === 1 ? 'the person' : '')
  })
}

/** The place as the row shows it, short: "left", "middle", "right",
 *  "later from the left", "main person". Empty: not set yet. */
export function personPlaceShort(rows: readonly PersonRow[], i: number): string {
  const long = personPlaces(rows)[i] ?? ''
  if (rows[i]?.later) return `later from the ${rows[i].later}`
  if (!long) return ''
  if (long === 'the person') return 'main person'
  return long.replace(/^the person (on the |in the )?/, '').replace(/^the /, '')
}

/** H3's form: one sentence, "The person on the left is <Picture 1>, the
 *  person who walks in later from the right is <Picture 2>." */
export function peopleSentence(rows: readonly PersonRow[]): string {
  const places = personPlaces(rows)
  const parts = places.map((p, i) => `${p || 'the person'} is <Picture ${i + 1}>`)
  if (!parts.length) return ''
  const s = parts.join(', ')
  return `${s[0].toUpperCase()}${s.slice(1)}.`
}

export interface PeopleCheck {
  /** A note per row, or null where the row is fine. */
  rows: (string | null)[]
  /** Why Create waits, or null. */
  blocker: string | null
  /** A model that can do it, with the reason. Only a click picks it. */
  recommend: { model: string; name: string; reason: string } | null
}

/** Checks the rows against a model. `available` are the models the user can
 *  pick here (local mode: the local way; cloud: the cloud models). */
export function checkPeople(model: string, rows: readonly PersonRow[], available: readonly string[] = SWAP_RECOMMEND_ORDER): PeopleCheck {
  const can = swapCan(model)
  const n = Math.max(1, rows.length)
  const out: (string | null)[] = rows.map(() => null)
  let blocker: string | null = null
  let need = null as 'people' | 'later' | null

  rows.forEach((r, i) => {
    if (r.later && !can.later) {
      out[i] = `${can.name} needs everyone in the first frame.`
      blocker ??= `${can.name} needs everyone in the first frame. Person ${i + 1} comes in later.`
      need ??= 'later'
    }
  })
  if (n > can.people) {
    const text = `${can.name} replaces ${can.people === 1 ? 'one person' : `up to ${can.people} people`}.`
    for (let i = can.people; i < rows.length; i++) out[i] ??= text
    blocker = `${text} Remove ${n - can.people === 1 ? 'a person' : `${n - can.people} people`} or pick another model.`
    need = 'people'
  }

  let recommend: PeopleCheck['recommend'] = null
  if (blocker) {
    const laterNeeded = rows.some((r) => r.later)
    const fits = SWAP_RECOMMEND_ORDER.find((id) =>
      id !== model && available.includes(id) && swapCan(id).people >= n && (!laterNeeded || swapCan(id).later))
    if (fits) {
      const c = swapCan(fits)
      const reason = need === 'later' || (laterNeeded && !can.later)
        ? 'takes a person who walks in later'
        : c.people === 1 ? 'one person' : `takes up to ${c.people} people`
      recommend = { model: fits, name: c.name, reason }
    }
  }
  return { rows: out, blocker, recommend }
}

/** The line at Create when no model the user can pick here fits: where it
 *  can run instead (local mode: LU Cloud). */
export function peopleElsewhere(rows: readonly PersonRow[], local: boolean, available: readonly string[]): string | null {
  const n = Math.max(1, rows.length)
  const later = rows.some((r) => r.later)
  if (later && !available.some((id) => swapCan(id).later)) {
    return 'No model in this app takes a person who walks in later. Start the clip once they are in, then tap them.'
  }
  if (local && n > swapCan(SWAP_LOCAL_MODEL).people) return `${n} people at once run on LU Cloud (SCAIL-2 takes up to 3).`
  return null
}

/** What stands in the local panel before the start (grey, not a warning). */
export const SWAP_LOCAL_TIPS = [
  'Runs on your computer with Wan 2.2 Animate. One person, the first 5 seconds.',
  'Best with one person in the video: the swap follows every body it finds.',
  'One continuous shot, no hard cuts. The original sound stays.',
] as const
