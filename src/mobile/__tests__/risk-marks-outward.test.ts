/**
 * A target that leaves the app or opens a sensor says so before it is tapped.
 *
 * The risk mark (ui/common.ts) knew `paid` and `destructive`. The camera and
 * the photo library, and every link that opens the browser, the mail app, the
 * settings of the system or the share sheet had no mark, so a sweep over the
 * app could not tell them from a harmless row (mobile-docs/r5/rest.md, open).
 * Now there are `leaves-app` and `sensor`.
 *
 * This guard reads the sources and finds a target without a mark:
 *   1. It knows the doors of the platform seam (openExternal, takePhoto, ...).
 *   2. A function that calls a door is a door itself, across files, so a
 *      handler named `share` or a helper named `openLink` counts.
 *   3. Every JSX element whose onPress or onClick reaches a door has to carry
 *      `risk` (or riskProps on a plain element). Any mark is accepted: the
 *      heavier one wins, a link to the plans is `paid`.
 *   4. A row that opens the browser also says so in words: it carries a
 *      second line ("Opens github.com in your browser"). The mark is for a
 *      sweep, the line is for the person (second check on Android, F3).
 * The second part holds the list of marked test ids against the sources.
 *
 * Run: npx vitest run src/mobile/__tests__/risk-marks-outward.test.ts
 */
import { describe, expect, it } from 'vitest'
import { RISKS } from '../ui/common'
import { MOBILE_DIR, sourceFiles, stripComments } from './scan'

type Outward = 'leaves-app' | 'sensor'

/** The doors of the platform seam and of the voice hook. */
const DOORS: Record<string, Outward> = {
  openExternal: 'leaves-app',
  openSystemSettings: 'leaves-app',
  shareFile: 'leaves-app',
  shareText: 'leaves-app',
  shareUrl: 'leaves-app',
  takePhoto: 'sensor',
  pickPhotos: 'sensor',
  scanQr: 'sensor',
  saveUrlToPhotos: 'sensor',
  startRecording: 'sensor',
}

/**
 * Doors the scan cannot see by itself:
 *   saveImage       saveToDevice writes to the photo library only with target
 *                   'photos', and that one call sits in saveImage.
 *   saveOrShare     lives in src/lib, outside the folder read here. On a phone
 *                   it is the share sheet.
 *   contactSupport  opens the mail app through a door it is handed (parts/contact.ts).
 * Not a door: saveToDevice with target 'files'. It opens the save dialog of
 * the system and comes back to the app with the file written.
 */
const ALSO_DOORS: Record<string, Outward> = { saveImage: 'sensor', saveOrShare: 'leaves-app', contactSupport: 'leaves-app' }

/**
 * Helpers that call a door and are no way out for the one who calls them:
 * they only ever run after the user answered a question the target opened.
 */
const NOT_A_DOOR = new Set<string>([
  // boot/wiring.ts: the handler of a save request of the logic layer, not a function a target calls.
  'handOverSave',
])

/** Targets that reach a door and carry no mark, each with its reason. Keep this short. */
const WITHOUT_MARK: Record<string, string> = {
  // One handler for two rows: `backup('share')` opens the share sheet and carries the mark, `backup('save')` writes into the folder of the app and opens nothing.
  'm-settings-data-backup-save': 'The same handler as the share row; this way of it saves on the phone and leaves nothing.',
}

const files = sourceFiles(MOBILE_DIR, ['.ts', '.tsx']).filter(
  (f) => !f.rel.startsWith('mobile/platform/') && !f.rel.startsWith('mobile/dev/') && !f.rel.startsWith('mobile/strings/'),
)
const code = new Map<string, string>(files.map((f) => [f.rel, stripComments(f.text)]))

/** The text from `start` to the end of the statement: brackets closed, then the end of the line. */
function statementFrom(text: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') {
      depth--
      if (depth < 0) return text.slice(start, i)
      // A function declaration ends with the brace that closes its body.
      if (depth === 0 && c === '}' && /^\s*(?:export\s+)?(?:async\s+)?function\b/.test(text.slice(start, start + 40))) return text.slice(start, i + 1)
    } else if (c === '\n' && depth === 0) return text.slice(start, i)
  }
  return text.slice(start)
}

interface Declared {
  name: string
  exported: boolean
  body: string
}

const DECLARATION = /(^|\n)[ \t]*(export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=)/g

function declarationsOf(text: string): Declared[] {
  const out: Declared[] = []
  for (const m of text.matchAll(DECLARATION)) {
    const at = (m.index ?? 0) + m[1].length
    out.push({ name: m[3] ?? m[4], exported: !!m[2], body: statementFrom(text, at) })
  }
  return out
}

const calls = (text: string, name: string) => new RegExp(`(?<![\\w$])${name.replace('$', '\\$')}\\s*\\(`).test(text)
const names = (text: string, name: string) => new RegExp(`(?<![\\w$.])${name.replace('$', '\\$')}(?![\\w$])`).test(text)

/** The one door that opens the browser. What reaches it is a link, not a share sheet and not the mail app. */
const BROWSER_DOOR: Record<string, Outward> = { openExternal: 'leaves-app' }

/**
 * Every function that reaches a door: exported ones for all files, the others for their own file.
 * With `seed` only the functions that reach one of those doors.
 */
function doorsOfTheApp(seed: Record<string, Outward> = { ...DOORS, ...ALSO_DOORS }): { everywhere: Map<string, Outward>; inFile: Map<string, Map<string, Outward>> } {
  const everywhere = new Map<string, Outward>(Object.entries(seed))
  const inFile = new Map<string, Map<string, Outward>>()
  const declared = new Map<string, Declared[]>([...code].map(([rel, text]) => [rel, declarationsOf(text)]))
  for (let changed = true; changed; ) {
    changed = false
    for (const [rel, list] of declared) {
      const local = inFile.get(rel) ?? new Map<string, Outward>()
      inFile.set(rel, local)
      for (const d of list) {
        if (NOT_A_DOOR.has(d.name) || local.has(d.name)) continue
        // The body without the name it declares, so a function is not its own door.
        const body = d.body.replace(new RegExp(`(?:function|const)\\s+${d.name}\\b`), '')
        const known = [...everywhere, ...local]
        const hit = known.find(([name]) => name !== d.name && calls(body, name))
        if (!hit) continue
        local.set(d.name, hit[1])
        if (d.exported && !everywhere.has(d.name)) everywhere.set(d.name, hit[1])
        changed = true
      }
    }
  }
  return { everywhere, inFile }
}

interface Target {
  file: string
  tag: string
  testid: string | null
  door: string
  kind: Outward
  marked: boolean
  /** The handler reaches the browser (openExternal), directly or through a helper. */
  browser: boolean
  /** The element carries a second line (`subtitle`), where a row says where it leads. */
  says: boolean
}

/** The opening tag that starts at `<`, attributes and all. */
function openingTag(text: string, start: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && text[i - 1] !== '=') return text.slice(start, i + 1)
  }
  return text.slice(start)
}

/**
 * The attributes of an opening tag, each with its value as written. Only the
 * tag's own: what stands inside a value (the buttons in `actions={...}` of a
 * notice) belongs to the elements in there, and they are looked at on their own.
 */
function ownAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  let i = tag.search(/[\s\n]/)
  let spread = 0
  while (i !== -1 && i < tag.length) {
    const rest = tag.slice(i)
    const lead = rest.match(/^[\s\n]+/)
    if (lead) {
      i += lead[0].length
      continue
    }
    const end = (open: number): number => {
      let depth = 0
      let quote: string | null = null
      for (let k = open; k < tag.length; k++) {
        const c = tag[k]
        if (quote) {
          if (c === '\\') k++
          else if (c === quote) quote = null
        } else if (c === '"' || c === "'" || c === '`') quote = c
        else if (c === '{') depth++
        else if (c === '}' && --depth === 0) return k
      }
      return tag.length - 1
    }
    if (rest.startsWith('{')) {
      const close = end(i)
      out.set(`...${spread++}`, tag.slice(i + 1, close))
      i = close + 1
      continue
    }
    const name = rest.match(/^[A-Za-z_][\w-]*/)
    if (!name) {
      i++
      continue
    }
    i += name[0].length
    if (tag[i] !== '=') {
      out.set(name[0], 'true')
      continue
    }
    i++
    if (tag[i] === '{') {
      const close = end(i)
      out.set(name[0], tag.slice(i + 1, close))
      i = close + 1
    } else if (tag[i] === '"' || tag[i] === "'") {
      const close = tag.indexOf(tag[i], i + 1)
      out.set(name[0], tag.slice(i, close + 1))
      i = close + 1
    }
  }
  return out
}

/** The mark an element carries itself: `risk`, `micRisk` of the Composer, or riskProps spread on a plain element. */
function markOf(attrs: Map<string, string>): string | null {
  const direct = attrs.get('risk') ?? attrs.get('micRisk')
  if (direct) return direct
  for (const [name, value] of attrs) if (name.startsWith('...') && /riskProps\(/.test(value)) return value
  return null
}

const testidOf = (attrs: Map<string, string>): string | null => {
  const raw = attrs.get('testid') ?? attrs.get('data-testid')
  return raw ? raw.replace(/^["'`]|["'`]$/g, '') : null
}

/** What a tap runs: onPress and onClick, and onDictate of the Composer (the microphone). */
const HANDLERS = ['onPress', 'onClick', 'onDictate']

function targetsThatReachADoor(): Target[] {
  const { everywhere, inFile } = doorsOfTheApp()
  const toBrowser = doorsOfTheApp(BROWSER_DOOR)
  const out: Target[] = []
  for (const [rel, text] of code) {
    if (!rel.endsWith('.tsx')) continue
    const doors = new Map<string, Outward>([...everywhere, ...(inFile.get(rel) ?? [])])
    const browserDoors = new Map<string, Outward>([...toBrowser.everywhere, ...(toBrowser.inFile.get(rel) ?? [])])
    for (const m of text.matchAll(/<([A-Za-z][\w.]*)(?=[\s\n])/g)) {
      const tag = openingTag(text, m.index ?? 0)
      const attrs = ownAttributes(tag)
      const handler = HANDLERS.map((name) => attrs.get(name)).find((value) => value !== undefined)
      if (!handler) continue
      const hit = [...doors].find(([name]) => names(handler, name))
      if (!hit) continue
      const browser = [...browserDoors].some(([name]) => names(handler, name))
      out.push({ file: rel, tag: m[1], testid: testidOf(attrs), door: hit[0], kind: hit[1], marked: markOf(attrs) !== null, browser, says: attrs.has('subtitle') })
    }
  }
  return out
}

const targets = targetsThatReachADoor()

describe('the scan sees what it is meant to see', () => {
  it('finds helpers that wrap a door, across files', () => {
    const { everywhere } = doorsOfTheApp()
    // screens/settings/parts/links.ts and policy/links.ts wrap openExternal.
    expect(everywhere.get('openLink')).toBe('leaves-app')
    // screens/chat/parts/adapters/handover.ts wraps the share sheet.
    expect(everywhere.get('exportChat')).toBe('leaves-app')
    expect(everywhere.get('shareMessageText')).toBe('leaves-app')
    // screens/create/parts/media-out.ts
    expect(everywhere.get('shareItem')).toBe('leaves-app')
    expect(everywhere.get('saveItem')).toBe('sensor')
  })

  it('finds the targets of every strand, both kinds', () => {
    const found = targets.map((t) => t.testid)
    for (const id of ['m-settings-about-website', 'm-chat-attach-photo', 'm-chat-message-share', 'm-create-source-take', 'm-remote-attach-camera', 'm-account-manage', 'm-create-pastdue-action', 'm-settings-about-contact', 'm-memory-export-md']) {
      expect(found, id).toContain(id)
    }
    expect(targets.length).toBeGreaterThan(40)
    expect(targets.some((t) => t.kind === 'sensor')).toBe(true)
    expect(targets.some((t) => t.kind === 'leaves-app')).toBe(true)
    // The microphone of the chat is a prop of the Composer, with a mark of its own.
    expect(targets.some((t) => t.tag === 'Composer' && t.door === 'dictate' && t.marked)).toBe(true)
  })

  it('a made up page with an unmarked link and an unmarked camera row is caught', () => {
    const page = `
      import { openLink } from './parts/links'
      export function Page() {
        const snap = async () => { await takePhoto() }
        return (<>
          <Row title="Website" onPress={() => void openLink('https://example.test')} testid="m-x-site" />
          <Row title="Photo" onPress={snap} testid="m-x-photo" />
          <Row title="Marked" onPress={snap} risk="sensor" testid="m-x-marked" />
          <Row title="Source" onPress={() => void openLink('https://example.test')} risk="leaves-app" testid="m-x-silent" />
          <Row title="Source" subtitle="Opens example.test in your browser" onPress={() => void openLink('https://example.test')} risk="leaves-app" testid="m-x-says" />
          <Row title="Inside" onPress={() => nav.push('/x')} testid="m-x-inside" />
        </>)
      }`
    code.set('mobile/screens/made-up/Page.tsx', page)
    try {
      const mine = targetsThatReachADoor().filter((t) => t.file === 'mobile/screens/made-up/Page.tsx')
      expect(mine.map((t) => [t.testid, t.kind, t.marked])).toEqual([
        ['m-x-site', 'leaves-app', false],
        ['m-x-photo', 'sensor', false],
        ['m-x-marked', 'sensor', true],
        ['m-x-silent', 'leaves-app', true],
        ['m-x-says', 'leaves-app', true],
      ])
      // A marked row that opens the browser without saying so is caught by the second rule, the camera row is not asked.
      expect(mine.filter((t) => t.tag === 'Row' && t.browser && !t.says).map((t) => t.testid)).toEqual(['m-x-site', 'm-x-silent'])
    } finally {
      code.delete('mobile/screens/made-up/Page.tsx')
    }
  })
})

describe('no target leaves the app or opens a sensor without a mark', () => {
  it('every target that reaches a door carries a risk mark', () => {
    const open = targets
      .filter((t) => !t.marked)
      .map((t) => `${t.file}: <${t.tag}> ${t.testid ?? '(no test id)'} reaches ${t.door} (${t.kind})`)
      .filter((line) => !Object.keys(WITHOUT_MARK).some((key) => line.includes(key)))
    expect(open).toEqual([])
  })

  // Second check on Android, F3: "Source code" on About opened the browser and, unlike the three rows around it,
  // did not say so. The mark alone is not read by a person.
  it('every row that opens the browser says where it leads, in a second line', () => {
    const silent = targets.filter((t) => t.tag === 'Row' && t.browser && !t.says).map((t) => `${t.file}: ${t.testid ?? '(no test id)'} opens the browser through ${t.door} and has no subtitle`)
    expect(silent).toEqual([])
    // The rule looks at something: these are rows that open the browser.
    const rows = targets.filter((t) => t.tag === 'Row' && t.browser).map((t) => t.testid)
    for (const id of ['m-settings-about-website', 'm-settings-about-source', 'm-settings-about-privacy', 'm-settings-about-terms', 'm-models-detail-hf', 'm-account-api-keys']) expect(rows, id).toContain(id)
    // And it is not asked of what does not open the browser: the mail app, a share sheet.
    expect(targets.find((t) => t.testid === 'm-chat-message-share')?.browser).toBe(false)
  })

  it('the second line of a link row is a sentence that names the browser', async () => {
    const { SETTINGS_STRINGS } = await import('../strings/settings')
    const { MODELS_STRINGS } = await import('../strings/models')
    for (const line of [SETTINGS_STRINGS.common.onLuLabs, SETTINGS_STRINGS.about.sourceOpens, MODELS_STRINGS.detail.viewHfOpens]) {
      expect(line).toMatch(/^Opens .*in your browser$/)
      expect(line).not.toMatch(/[–—]/)
    }
    expect(SETTINGS_STRINGS.about.sourceOpens).toBe('Opens github.com in your browser')
    expect(MODELS_STRINGS.detail.viewHfOpens).toBe('Opens huggingface.co in your browser')
  })

  it('the two finds of the check would be caught: the link without a mark, and the row without its line', () => {
    const inFile = (rel: string, change: (text: string) => string): Target[] => {
      const before = code.get(rel)!
      const after = change(before)
      expect(after, `${rel}: the change took`).not.toBe(before)
      code.set(rel, after)
      try {
        return targetsThatReachADoor().filter((t) => t.file === rel)
      } finally {
        code.set(rel, before)
      }
    }
    // (1) Models, "View on Hugging Face" as it stood in the checked package: no mark.
    const detail = inFile('mobile/screens/models/ModelDetailPage.tsx', (text) => text.replace(/(title=\{S\.detail\.viewHf\}[^>]*?) risk="leaves-app"/, '$1'))
    expect(detail.filter((t) => !t.marked).map((t) => t.testid)).toEqual(['m-models-detail-hf'])
    // (2) About, "Source code" as it stood: the mark, and no line.
    const about = inFile('mobile/screens/settings/AboutPage.tsx', (text) => text.replace(' subtitle={T.sourceOpens}', ''))
    expect(about.filter((t) => t.tag === 'Row' && t.browser && !t.says).map((t) => t.testid)).toEqual(['m-settings-about-source'])
    expect(about.filter((t) => !t.marked)).toEqual([])
  })

  it('the exceptions still exist and still have a reason', () => {
    for (const [key, reason] of Object.entries(WITHOUT_MARK)) {
      expect(targets.some((t) => !t.marked && `${t.file}: ${t.testid}`.includes(key)), key).toBe(true)
      expect(reason.length, key).toBeGreaterThan(20)
    }
  })
})

/** The test ids that carry one of the two new marks. The harness and TESTIDS.md name the same ones. */
export const OUTWARD_BY_ID: Record<string, Outward> = {
  // Links, mail, system settings, share sheet
  'm-md-link': 'leaves-app',
  'm-settings-remote-notices-open-settings': 'leaves-app',
  'm-models-detail-hf': 'leaves-app',
  'm-chat-link': 'leaves-app',
  'm-chat-link-open': 'leaves-app',
  'm-chat-menu-export-markdown': 'leaves-app',
  'm-chat-menu-export-json': 'leaves-app',
  'm-chat-file-share': 'leaves-app',
  'm-chat-message-share': 'leaves-app',
  'm-memory-export-md': 'leaves-app',
  'm-memory-export-json': 'leaves-app',
  'm-create-item-share': 'leaves-app',
  'm-create-result-share': 'leaves-app',
  // R53: the result of "My computer" shares like a cloud result.
  'm-create-computer-share': 'leaves-app',
  'm-remote-scan-settings': 'leaves-app',
  'm-settings-voice-open-system': 'leaves-app',
  'm-settings-data-backup': 'leaves-app',
  // The switch for download notifications: the question of the system, or its settings (round 16, F9).
  'm-settings-storage-notify': 'leaves-app',
  'm-settings-licenses-full': 'leaves-app',
  'm-settings-about-website': 'leaves-app',
  'm-settings-about-source': 'leaves-app',
  'm-settings-about-contact': 'leaves-app',
  'm-settings-about-privacy': 'leaves-app',
  'm-settings-about-terms': 'leaves-app',
  'm-settings-privacy-policy': 'leaves-app',
  'm-settings-troubleshooting-share-log': 'leaves-app',
  'm-settings-troubleshooting-share-report': 'leaves-app',
  'm-settings-content-policy-fixed-open': 'leaves-app',
  'm-account-api-keys': 'leaves-app',
  // The privacy policy inside the consent to LU Cloud (round 28, R5).
  'm-consent-privacy': 'leaves-app',
  // Camera, photo library
  'm-chat-attach-photo': 'sensor',
  'm-chat-attach-library': 'sensor',
  'm-chat-file-save': 'sensor',
  'm-create-source-take': 'sensor',
  'm-create-source-library': 'sensor',
  'm-create-char-add': 'sensor',
  'm-create-batch-add': 'sensor',
  'm-create-reference-add': 'sensor',
  'm-create-3d-side-add': 'sensor',
  'm-create-3d-video-add': 'sensor',
  'm-create-source-video': 'sensor',
  'm-create-preset-input-file': 'sensor',
  'm-create-item-save': 'sensor',
  'm-create-result-save': 'sensor',
  'm-create-computer-save': 'sensor',
  'm-create-computer-add-image': 'sensor',
  'm-create-computer-photo-add': 'sensor',
  'm-remote-shared-attach': 'sensor',
  'm-create-computer-photo-take': 'sensor',
  'm-remote-chat-step-media-save': 'sensor',
  'm-create-gallery-save': 'sensor',
  'm-remote-attach-camera': 'sensor',
  'm-remote-attach-library': 'sensor',
  'm-remote-scan': 'sensor',
  'm-remote-connect-scan': 'sensor',
  'm-remote-scan-again': 'sensor',
  'm-settings-appearance-picture-choose': 'sensor',
}

describe('the list of marked test ids and the sources agree', () => {
  const all = [...code.values()].join('\n')

  it('the kit knows the four values and writes them through riskProps', () => {
    expect([...RISKS]).toEqual(['paid', 'destructive', 'leaves-app', 'sensor'])
  })

  for (const [id, mark] of Object.entries(OUTWARD_BY_ID)) {
    it(`${id} carries ${mark}`, () => {
      const base = id.replace(/^m-md-/, '')
      const where = id === 'm-md-link' ? /data-testid=\{`\$\{idPrefix\}-link`\}/ : new RegExp(`testid="${id}"`)
      const at = all.search(where)
      expect(at, `${base} not found in the sources`).toBeGreaterThan(-1)
      const tagStart = all.lastIndexOf('<', at)
      const mine = markOf(ownAttributes(openingTag(all, tagStart))) ?? ''
      expect(mine).toMatch(new RegExp(`^"${mark}"$|riskProps\\('${mark}'\\)|'${mark}' : undefined`))
    })
  }

  it('no other target carries one of the two new marks without standing in the list', () => {
    const marked = new Set<string>()
    for (const m of all.matchAll(/<[A-Za-z][\w.]*(?=[\s\n])/g)) {
      const attrs = ownAttributes(openingTag(all, m.index ?? 0))
      if (!/leaves-app|sensor/.test(markOf(attrs) ?? '')) continue
      const id = testidOf(attrs)
      if (id) marked.add(id)
    }
    const known = new Set([...Object.keys(OUTWARD_BY_ID), '${idPrefix}-link', '${id}-scan-new'])
    expect([...marked].filter((id) => !known.has(id)).sort()).toEqual([])
  })
})
