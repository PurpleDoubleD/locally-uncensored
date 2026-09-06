/** Compact relative timestamp for thin history rows: "now", "5m", "3h", "2d", "1w".
 *  Ported 1:1 from apps/web/lib/time-ago.ts so the recent-chats list on the
 *  desktop home screen reads exactly like the web one. */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 60) return 'now'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h`
  const d = h / 24
  if (d < 7) return `${Math.floor(d)}d`
  return `${Math.floor(d / 7)}w`
}
