/**
 * Eine Zahl mit Tausendertrennern fuer die Oberflaeche.
 *
 * Mit fester Sprache, nicht mit der des Betriebssystems. Persona P2 hat am
 * 04.09.2026 auf der deutschen Windows-Box gemessen, was `toLocaleString()`
 * ohne Sprache anrichtet: die Statuszeile der Engine lautete
 * "Engine running · Phi-4-mini-instruct-Q4_K_M · ctx 8.192". Gemeint sind
 * 8192 Token, in einer englischen Oberflaeche liest sich "8.192" als eine
 * Zahl kleiner als neun. Dieselbe Zahl stand zwei Zeilen tiefer im
 * Eingabefeld richtig als 8192. Auch "9.766 downloads" in den
 * CivitAI-Treffern war betroffen.
 *
 * Die Oberflaeche dieser Anwendung ist Englisch, also sind es ihre Zahlen
 * auch. Hausregel: keine lokalisierten Systemtexte durchreichen.
 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export function formatEta(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
}

// #162: the bracket next to the Rebuilding spinner. Empty until the backend
// has announced a total, so a plain spinner never grows a "(0 B of 0 B)".
export function downloadSuffix(p: { progress: number; total: number; speed: number }): string {
  if (!p.total) return ''
  const parts = [`${formatBytes(p.progress)} of ${formatBytes(p.total)}`]
  if (p.speed > 0) {
    parts.push(`${formatBytes(p.speed)}/s`)
    parts.push(`~${formatEta(Math.max(0, p.total - p.progress) / p.speed)} left`)
  }
  return ` (${parts.join(', ')})`
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength) + '...'
}
