// Watchers: what the tool call says about time, turned into the schedule Rust
// keeps, and the schedule turned back into the few words the line above the
// composer shows. Pure, so the rules are tested without a clock.

import type { WatcherRights, WatcherSchedule } from './types'

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const pad = (n: number) => String(n).padStart(2, '0')

/** "18:00". */
export function clockText(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "18:00", "tomorrow 08:00", "Mon 07:30" or "21 Nov 09:00", from `now`. */
export function whenText(ms: number, now: number): string {
  const d = new Date(ms)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(d, today)) return clockText(ms)
  if (sameDay(d, tomorrow)) return `tomorrow ${clockText(ms)}`
  if (ms - now < 6 * 24 * 60 * 60 * 1000 && ms > now) return `${DAY_LABELS[(d.getDay() + 6) % 7]} ${clockText(ms)}`
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${clockText(ms)}`
}

/** "every day", "Mon–Fri", "Sat, Sun", "every 2 h", "once". */
export function repeatText(s: WatcherSchedule): string {
  if (s.kind === 'once') return 'once'
  if (s.kind === 'interval') {
    if (s.minutes % 60 === 0) return s.minutes === 60 ? 'every hour' : `every ${s.minutes / 60} h`
    return `every ${s.minutes} min`
  }
  const days = [...new Set(s.days)].sort((a, b) => a - b)
  if (days.length === 0 || days.length === 7) return `every day ${pad(s.hour)}:${pad(s.minute)}`
  const label = days.join(',') === '0,1,2,3,4' ? 'Mon–Fri' : days.join(',') === '5,6' ? 'Sat, Sun' : days.map((d) => DAY_LABELS[d]).join(', ')
  return `${label} ${pad(s.hour)}:${pad(s.minute)}`
}

/** What a watcher may do, in a few words: "web · files and shell in ~/shop". */
export function rightsText(r: WatcherRights, folder: string | null, home = ''): string {
  const short = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  const where = folder ? ` in ${short(folder)}` : ' in its own folder'
  const parts: string[] = []
  if (r.web) parts.push('web')
  if (r.files && r.terminal) parts.push(`files and shell${where}`)
  else if (r.files) parts.push(`files${where}`)
  else if (r.terminal) parts.push(`shell${where}`)
  if (r.create) parts.push('pictures and video')
  if (r.extra_folders.length) parts.push(`also ${r.extra_folders.map(short).join(', ')}`)
  return parts.length ? parts.join(' · ') : 'answers only, no tools'
}

export type ScheduleResult = { ok: true; schedule: WatcherSchedule } | { ok: false; error: string }

const HHMM = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/

function parseHHMM(text: string): { hour: number; minute: number } | null {
  const m = HHMM.exec(text)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2] ?? '0')
  return hour <= 23 && minute <= 59 ? { hour, minute } : null
}

/**
 * The tool's arguments as a schedule. `repeat`: once | daily | weekdays |
 * interval. `time` is HH:MM (local) for once and daily; `date` (YYYY-MM-DD)
 * is optional for once, without it the next such time today or tomorrow.
 * `in_minutes` is an alternative for once ("in 20 minutes").
 */
export function scheduleFromArgs(args: Record<string, unknown>, now: number): ScheduleResult {
  const repeat = String(args.repeat ?? 'once').toLowerCase().trim()
  const time = typeof args.time === 'string' ? args.time : ''
  if (repeat === 'interval') {
    const minutes = Math.round(Number(args.every_minutes))
    if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: 'interval needs every_minutes, e.g. 60.' }
    return { ok: true, schedule: { kind: 'interval', minutes } }
  }
  if (repeat === 'once') {
    const inMinutes = Number(args.in_minutes)
    if (Number.isFinite(inMinutes) && inMinutes > 0) {
      return { ok: true, schedule: { kind: 'once', at: now + Math.round(inMinutes) * 60_000 } }
    }
    const hm = parseHHMM(time)
    if (!hm) return { ok: false, error: 'once needs time as HH:MM (24 h, local), or in_minutes.' }
    const d = new Date(now)
    if (typeof args.date === 'string' && args.date.trim()) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date.trim())
      if (!m) return { ok: false, error: 'date is YYYY-MM-DD.' }
      const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hm.hour, hm.minute, 0, 0).getTime()
      return { ok: true, schedule: { kind: 'once', at } }
    }
    d.setHours(hm.hour, hm.minute, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return { ok: true, schedule: { kind: 'once', at: d.getTime() } }
  }
  if (repeat === 'daily' || repeat === 'weekdays') {
    const hm = parseHHMM(time)
    if (!hm) return { ok: false, error: `${repeat} needs time as HH:MM (24 h, local).` }
    let days: number[] = []
    if (repeat === 'weekdays') {
      const raw = Array.isArray(args.days) ? args.days : []
      days = raw.map((x) => DAY_NAMES.indexOf(String(x).toLowerCase().slice(0, 3) as typeof DAY_NAMES[number])).filter((i) => i >= 0)
      if (days.length === 0) return { ok: false, error: 'weekdays needs days, e.g. ["mon","wed"].' }
    }
    return { ok: true, schedule: { kind: 'daily', hour: hm.hour, minute: hm.minute, days: [...new Set(days)].sort((a, b) => a - b) } }
  }
  return { ok: false, error: 'repeat is once, daily, weekdays or interval.' }
}
