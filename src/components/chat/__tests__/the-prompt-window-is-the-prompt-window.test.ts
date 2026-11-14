/**
 * THE RULE, and it is not negotiable:
 *
 *   "Im Promptfenster darf nichts von Plaenen zu sehen sein.
 *    Das Promptfenster ist das Promptfenster."
 *
 * The owner has asked for this five times. Every previous round fixed ONE surface
 * and the plan reappeared on the next one: G8-1 took the plan bar and the plan
 * progress out of the Agent transcript, 2.6.6 C2 moved the plan out of the Code
 * composer into the right-hand panel, and the Chat and Agent composer, plus the
 * Approve-and-run card on Code, carried a plan the whole time regardless.
 *
 * So this file is not a sixth fix. It is the invariant: NO composer on ANY
 * surface may import or render anything that shows a plan, checked over the
 * whole component tree the composer is built from, not just the top level. A
 * colleague who puts a plan back at the prompt box in six weeks gets this test
 * red with the owner's sentence in the failure message.
 *
 * Three surfaces, two files: ChatView is both Chat and Agent (Agent is a toggle
 * inside the LU tab, not a view of its own), CodexView is Code. ChatInput is
 * the prompt window itself and is checked as a whole.
 *
 * Where a plan is allowed to be instead:
 *   - The run's progress list (PlanBar): pinned under the newest message,
 *     INSIDE the transcript, on every surface (MessageList for Chat and Agent,
 *     CodexView's transcript for Code). David, 13.11.2026: like the Claude Code
 *     desktop app. It is part of the conversation, not of the prompt box.
 *   - Approve-and-run (PlanApprovalBar): the BOTTOM of the Explorer column on
 *     Code, below the tree and the file preview.
 *
 * Run: npx vitest run src/components/chat/__tests__/the-prompt-window-is-the-prompt-window.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const COMPONENTS = resolve(here, '../..')
const CHAT = resolve(here, '..')

const THE_RULE =
  'Im Promptfenster darf nichts von Plaenen zu sehen sein. Das Promptfenster ist das Promptfenster.'

const WHERE_IT_BELONGS =
  'The plan has a home: pinned under the newest message inside the transcript (PlanBar in ' +
  'MessageList and in CodexView\'s transcript), and Approve-and-run at the bottom of the Explorer column. Put it there.'

/** Every component file under src/components, by component name. */
function componentFiles(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      componentFiles(full, out)
      continue
    }
    if (!entry.name.endsWith('.tsx')) continue
    const name = basename(entry.name, '.tsx')
    if (!/^[A-Z]/.test(name)) continue
    out[name] = full
  }
  return out
}

const FILES = componentFiles(COMPONENTS)

/**
 * What counts as "showing a plan", derived from the tree rather than hardcoded,
 * so a PlanFooBar.tsx added next year is banned the day it is created:
 *   - any component file whose name starts with "Plan"
 *   - the two stores a plan is read from, which catches a plan rendered inline
 *     without a component to name it
 */
const PLAN_COMPONENTS = Object.keys(FILES).filter((n) => n.startsWith('Plan'))
const PLAN_STORE_READS = ['useTodoStore', 'planApprovalByConversation']

/** The JSX/expression a prop is given, brace balanced from `prop={`. */
function propValue(src: string, prop: string): string {
  const start = src.indexOf(`${prop}={`)
  if (start < 0) return ''
  let i = start + prop.length + 1
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

/** Locally rendered or imported component names, resolvable to a file. */
function referenced(src: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) names.add(m[1])
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.[^']*'/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/\btype\b/, '').trim().split(/\s+as\s+/)[0].trim()
      if (/^[A-Z]/.test(name)) names.add(name)
    }
  }
  return [...names].filter((n) => FILES[n])
}

/** Anything in this source that shows a plan, named for the failure message. */
function planSightings(src: string): string[] {
  const hits: string[] = []
  for (const name of PLAN_COMPONENTS) {
    if (new RegExp(`<${name}[\\s/>]`).test(src)) hits.push(`renders <${name}>`)
    else if (new RegExp(`\\b${name}\\b`).test(src)) hits.push(`imports ${name}`)
  }
  for (const read of PLAN_STORE_READS) {
    if (src.includes(read)) hits.push(`reads the plan itself via ${read}`)
  }
  return hits
}

/**
 * Walks the whole component tree a composer is built from and reports the first
 * plan it finds, with the path that got there.
 */
function scanTree(roots: { label: string; src: string }[]): string[] {
  const failures: string[] = []
  const seen = new Set<string>()
  const queue: { label: string; src: string }[] = [...roots]
  while (queue.length > 0) {
    const node = queue.shift()!
    for (const hit of planSightings(node.src)) failures.push(`${node.label} ${hit}`)
    for (const name of referenced(node.src)) {
      if (seen.has(name)) continue
      seen.add(name)
      queue.push({ label: `${node.label} > ${name}`, src: readFileSync(FILES[name], 'utf8') })
    }
  }
  return failures
}

const SURFACES = [
  { surface: 'Chat and Agent (LU tab)', file: 'ChatView.tsx' },
  { surface: 'Code (Code tab)', file: 'CodexView.tsx' },
]
const COMPOSER_PROPS = ['composerAbove', 'composerActions', 'composerModel']

describe('the plan components the invariant is about', () => {
  it('are found from the tree, not from a hardcoded list', () => {
    // If this ever comes back empty the whole file passes vacuously.
    expect(PLAN_COMPONENTS.sort()).toEqual(['PlanApprovalBar', 'PlanBar'])
  })

  it('offer no composer shape to reach for any more', () => {
    const src = readFileSync(resolve(CHAT, 'PlanBar.tsx'), 'utf8')
    // One shape only since CA (13.11.2026): pinned in the transcript.
    expect(src).not.toMatch(/PlanBarVariant/)
    expect(src).not.toMatch(/'composer'/)
  })
})

describe('no composer on any surface shows a plan', () => {
  for (const { surface, file } of SURFACES) {
    it(`${surface}: nothing handed to the prompt box, at any depth, shows a plan`, () => {
      const src = readFileSync(resolve(CHAT, file), 'utf8')
      const roots = COMPOSER_PROPS.map((prop) => ({
        label: `${file} ${prop}`,
        src: propValue(src, prop),
      })).filter((r) => r.src.length > 0)
      // Sanity: the extraction has to have found something, or this test would
      // pass by reading nothing at all. `composerModel` is the anchor now, not
      // `composerAbove`: on 21.09.2026 the prompt box was emptied out for real
      // (the owner: „NICHTS im prompt fenster!"). The Code surface hands it
      // nothing at all any more, and Chat hands it one money line. The picker
      // is what every surface still puts INTO the box, so it is the thing
      // whose absence would make this claim vacuous.
      expect(roots.map((r) => r.label)).toContain(`${file} composerModel`)
      expect(roots.find((r) => r.label === `${file} composerModel`)!.src).toMatch(/<ModelSelector/)

      const failures = scanTree(roots)
      expect(
        failures,
        `${failures.join('; ')}. ${THE_RULE} ${WHERE_IT_BELONGS}`,
      ).toEqual([])
    })
  }

  it('ChatInput, the prompt window itself, knows nothing about plans', () => {
    const failures = scanTree([
      { label: 'ChatInput.tsx', src: readFileSync(resolve(CHAT, 'ChatInput.tsx'), 'utf8') },
    ])
    expect(failures, `${failures.join('; ')}. ${THE_RULE} ${WHERE_IT_BELONGS}`).toEqual([])
  })
})

describe('and nothing sits immediately at the prompt box either', () => {
  // The subtree walk above only covers what is HANDED to ChatInput. A plan
  // rendered as a sibling right above <ChatInput> would look identical to the
  // user, so each surface also has to prove where its plan actually is.

  it('the LU tab renders its plan at the end of the transcript, inside MessageList', () => {
    const view = readFileSync(resolve(CHAT, 'ChatView.tsx'), 'utf8')
    const list = readFileSync(resolve(CHAT, 'MessageList.tsx'), 'utf8')
    // Not in ChatView itself, so nothing can stand as a sibling at the box.
    expect(view).not.toMatch(/<PlanBar\b/)
    expect(view.indexOf('<ChatInput')).toBeGreaterThan(view.indexOf('<MessageList'))
    // In MessageList: once, after the messages and the run anchor, inside the
    // scrolling transcript (the box that `scrollRef` scrolls).
    expect(list.match(/<PlanBar\b/g)).toHaveLength(1)
    const plan = list.indexOf('<PlanBar')
    expect(plan).toBeGreaterThan(list.indexOf('<WorkingAnchor'))
    expect(plan).toBeGreaterThan(list.indexOf('ref={scrollRef}'))
    expect(plan).toBeLessThan(list.indexOf('<CompactLayerRail'))
  })

  it('the Code tab renders its plan at the end of its transcript, never in the composer', () => {
    const src = readFileSync(resolve(CHAT, 'CodexView.tsx'), 'utf8')
    expect(src.match(/<PlanBar\b/g)).toHaveLength(1)
    const plan = src.indexOf('<PlanBar')
    expect(plan).toBeGreaterThan(src.indexOf('<WorkingAnchor'))
    expect(plan).toBeGreaterThan(src.indexOf('ref={scrollRef}'))
    expect(plan).toBeLessThan(src.indexOf('<CompactLayerRail'))
    expect(src).not.toMatch(/PlanApprovalBar/)
    // The approve callback still leaves from here, because this view owns the
    // send. Losing this line would leave an Approve button that runs nothing.
    expect(src).toMatch(/<ExplorerPanel onApprovePlan=\{\(text\) => sendInstruction\(text\)\} \/>/)
  })
})

describe('the Code panel keeps the approval card at the bottom', () => {
  // 2026-08-22: the plan sitting at the TOP of the column made no sense
  // to him. Files first, plan as the footer of the column.
  const src = readFileSync(resolve(CHAT, 'ExplorerPanel.tsx'), 'utf8')
  const tree = src.indexOf('{rows.map((row) => {')
  const preview = src.indexOf('<FilePreview')
  const approval = src.indexOf('<PlanApprovalBar')
  // The progress list left this column (CA, 13.11.2026); only the approval
  // card is still here, and the column does not repeat the list.
  it('without the progress list', () => {
    expect(src).not.toMatch(/<PlanBar\b/)
  })

  it('below the file tree', () => {
    expect(tree).toBeGreaterThan(-1)
    expect(approval).toBeGreaterThan(tree)
  })

  it('below the file preview, so it is the last section in the column', () => {
    expect(preview).toBeGreaterThan(-1)
    expect(approval).toBeGreaterThan(preview)
  })

  it('with the approval card, which came down from the composer with it', () => {
    expect(src).toMatch(/<PlanApprovalBar onApprove=\{onApprovePlan\} \/>/)
  })

  it('and a collapsed column still says a plan is waiting', () => {
    // The column can be collapsed to a 7px rail. Without this the only
    // Approve-and-run button in the app would be unreachable.
    expect(src).toMatch(/data-testid="explorer-plan-waiting"/)
    expect(src).toMatch(/A plan is waiting for your approval/)
  })
})
