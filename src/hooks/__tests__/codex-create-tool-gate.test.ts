/**
 * The create tools ride along on every coding step, and on the cloud path
 * nothing ever asked whether the turn wanted them.
 *
 * CODEX_CATEGORIES has carried this comment since v2.5.3: image and video
 * "only surface when the keyword router sees a creative intent in the prompt,
 * so pure coding turns keep the same lean tool list as before". That was true
 * for a LOCAL model, which goes through selectRelevantTools. A cloud model gets
 * `codexTools` handed straight to the request, so image_generate,
 * video_generate and run_workflow shipped on every step of every paid run.
 *
 * Measured 2026-08-12 against the model's own tokenizer (DeepSeek V4 Flash
 * 0731), serialised the way toOpenAITools puts it on the wire:
 *
 *   coding catalog today          30 tools   6.186 tokens per step
 *   without the three generators  27 tools   4.223 tokens per step
 *
 * 1.963 tokens per step, on the surface that bills per token, for three tools
 * a refactor never calls. Nothing is deleted: the same keyword weiche that has
 * always guarded them locally now guards them everywhere.
 *
 * The second half of this file is the part that makes it safe. A gated tool
 * list plus a system prompt that still promises asset generation is worse than
 * no gate at all: the model calls a tool it was told it has, gets "unknown
 * tool", and burns a step. Prompt and catalog answer the same question here.
 *
 * Run: npx vitest run src/hooks/__tests__/codex-create-tool-gate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { gateCreateTools, wantsMediaTools, CREATE_TOOLS, GATE_OPENING_TOOLS, isGatedTool } from '../../lib/tool-selection'
import { toolRegistry, DEFAULT_PERMISSIONS } from '../../api/mcp'

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../useCodex.ts'),
  'utf8',
)

// Mirrors CODEX_CATEGORIES in useCodex.ts, same reason as the sibling test:
// the point is to notice the constant moving without this file moving with it.
const CODEX_CATEGORIES = ['filesystem', 'terminal', 'system', 'web', 'image', 'video', 'workflow']
const codingCatalog = () =>
  toolRegistry.getAvailableTools(DEFAULT_PERMISSIONS).filter((t) => CODEX_CATEGORIES.includes(t.category))

const names = <T extends { name: string }>(ts: T[]) => ts.map((t) => t.name)

describe('a plain coding turn does not carry the generators', () => {
  it('drops all three on a refactor', () => {
    const out = names(gateCreateTools(codingCatalog(), 'refactor the auth guard and run the tests'))
    expect(out).not.toContain('image_generate')
    expect(out).not.toContain('video_generate')
    expect(out).not.toContain('run_workflow')
  })

  it('is a filter and not a wipe', () => {
    const out = names(gateCreateTools(codingCatalog(), 'refactor the auth guard and run the tests'))
    expect(out).toContain('file_read')
    expect(out).toContain('shell_execute')
    expect(out).toContain('todo_write')
  })

  it('removes exactly the gated tools from the real coding catalog and nothing else', () => {
    // A6 widened the gate from the three generators to five: pr_resume and
    // delegate_task shipped a schema on every step of every run that never
    // mentions a PR or a fan-out.
    //
    // 2.6.8 macht sieben daraus: check_tasks und message_agent sprechen UEBER
    // eine Delegation und gehoeren deshalb hinter dasselbe Tor wie sie. Ohne
    // das kostete ein gewoehnlicher Refactor-Zug 844 Zeichen Katalogtext fuer
    // zwei Werkzeuge, die auf ihm nichts zu tun haben — gefunden vom Deckel in
    // tool-catalog-tokens.test.ts, nicht von einem Menschen.
    const before = names(codingCatalog())
    const after = names(gateCreateTools(codingCatalog(), 'fix the failing test in parser.ts'))
    expect(before.length - after.length).toBe(7)
    expect(before.filter((n) => !after.includes(n)).sort()).toEqual([...GATE_OPENING_TOOLS].sort())
  })

  it('still gates per tool, not by category', () => {
    // The naive version of this gate filters by category. delegate_task is
    // category 'workflow' (sub-agent.ts) and joined the Code tab in audit B11
    // precisely because it was unreachable; a category filter would take
    // run_workflow out with it on a delegate ask, and vice versa.
    const out = names(gateCreateTools(codingCatalog(), 'split the work and fan out over the four files'))
    expect(out).toContain('delegate_task')
    expect(out).not.toContain('run_workflow')
    expect(out).not.toContain('image_generate')
  })

  it('ein Fan-out bringt die zwei Begleiter MIT, sonst waeren sie unerreichbar', () => {
    // Die Kehrseite der Torentscheidung, und sie muss festgenagelt sein:
    // haengt man check_tasks hinter ein Tor und vergisst, es zusammen mit
    // delegate_task zu oeffnen, kann ein Agent zwar delegieren, aber nie
    // nachsehen. Das waere schlimmer als der Katalogtext, den das Tor spart.
    const out = names(gateCreateTools(codingCatalog(), 'delegate this and fan out'))
    expect(out).toContain('delegate_task')
    expect(out).toContain('check_tasks')
    expect(out).toContain('message_agent')
  })

  it('a PR ask brings pr_resume back and nothing else', () => {
    const out = names(gateCreateTools(codingCatalog(), 'continue the pull request from yesterday'))
    expect(out).toContain('pr_resume')
    expect(out).not.toContain('delegate_task')
    expect(out).not.toContain('image_generate')
  })
})

describe('a creative turn keeps exactly what it asked for', () => {
  const gate = (msg: string) => names(gateCreateTools(codingCatalog(), msg))

  it('an image request keeps both generators, so image can still chain into video', () => {
    const out = gate('add a hero image to the landing page')
    expect(out).toContain('image_generate')
    expect(out).toContain('video_generate')
  })

  it('a video request keeps them too', () => {
    expect(gate('turn that into a video')).toContain('video_generate')
  })

  it('a workflow request keeps run_workflow and not the generators', () => {
    const out = gate('run the workflow that syncs the docs')
    expect(out).toContain('run_workflow')
    expect(out).not.toContain('image_generate')
  })

  it('an image request does not drag run_workflow in with it', () => {
    // Parity with TOOL_GROUPS: the two groups are separate there, so they stay
    // separate here. Otherwise the gate would quietly be more generous than the
    // router it is supposed to mirror.
    expect(gate('draw me a logo')).not.toContain('run_workflow')
  })

  it('German asks work, they are half our users', () => {
    expect(gate('zeichne mir ein Logo fuer die Startseite')).toContain('image_generate')
    expect(gate('animiere das Bild')).toContain('video_generate')
    expect(gate('bau mir eine Grafik dafuer')).toContain('image_generate')
  })

  it('naming the tool verbatim always wins, even with no other cue', () => {
    expect(gate('call video_generate with inputImage set')).toContain('video_generate')
    expect(gate('use run_workflow for this')).toContain('run_workflow')
  })

  it('the words that arrived with the gate are covered', () => {
    // These were NOT in TOOL_GROUPS before 2026-08-12. On the local path a miss
    // only meant a leaner list; with the gate on the cloud path a miss means a
    // capability the user had yesterday is gone, so they are pinned.
    for (const ask of ['make a logo', 'design an icon', 'a banner for the top', 'an avatar image', 'a poster', 'a thumbnail for it']) {
      expect(gate(ask), ask).toContain('image_generate')
    }
  })
})

describe('the prompt and the tool list answer the same question', () => {
  // The whole risk of this change in one property: the model must never be told
  // it can generate assets on a turn where the gate removed the tool.
  const asks = [
    'refactor the auth guard',
    'add a hero image to the landing page',
    'run the tests and commit',
    'zeichne mir ein Logo',
    'turn the screenshot into a video',
    'run the workflow that syncs the docs',
  ]

  it('the asset line is promised exactly when the generators survive the gate', () => {
    for (const ask of asks) {
      const kept = names(gateCreateTools(codingCatalog(), ask)).includes('image_generate')
      expect(wantsMediaTools(ask), ask).toBe(kept)
    }
  })
})

describe('the wiring in useCodex', () => {
  it('the gate runs on the routed list, so it covers all three branches', () => {
    expect(src).toMatch(/const relevantDefs = gateCreateTools\(routedDefs, lastUserMsg, createGateOpened\)/)
  })

  it('the hermes fallback is gated too, it carries the weakest models', () => {
    expect(src).toMatch(/gateCreateTools\(\s*\n?\s*toolRegistry\.toHermesToolDefs\(permissions\), instruction, createGateOpened,/)
  })

  it('the asset line never fires in review mode or on a read-only command', () => {
    // A read-only slash command strips MUTATING_TOOLS for the turn, so the
    // generators are gone there too. Promising them is the same broken promise.
    // Since 2.6.6 C1 the three read-only reasons (Code-Review Mode, a read-only
    // slash command, Plan mode) are one flag, and the asset line reads it.
    expect(src).toMatch(/const assetsPossible = !effectiveReadOnly && !settings\.smallModelMode/)
    expect(src).toMatch(/const effectiveReadOnly = settings\.codexReviewMode === true \|\| readOnlyTurn \|\| codexMode === 'plan'/)
  })

  it('the asset promise left the always-on prompt body', () => {
    const body = src.slice(src.indexOf('const CODEX_SYSTEM_PROMPT ='), src.indexOf('const CODEX_ASSET_LINE'))
    expect(body).not.toContain('- Asset generation:')
    expect(src).toContain('const CODEX_ASSET_LINE')
  })

  it('the remote branch still hands the routed list through untouched', () => {
    // The gate is deliberately the LAST step, not a rewrite of the branch: a
    // hosted model keeps the full coding catalog, minus the three.
    expect(src).toMatch(/!isLocalModelByName\(activeModel\)\s*\n?\s*\?\s*codexTools/)
  })
})

describe('a run that discovers halfway through that it needs a picture', () => {
  // The hole the review found in this very fix (2026-08-14). "build me a
  // landing page for my bakery" matches no keyword, so the two generators are
  // stripped AND the asset line is absent. Before the gate the model simply
  // called image_generate and it worked, because toolRegistry.execute resolves
  // by name and never looks at the offered list. Without a way back the model
  // writes <img src="hero.jpg"> against a file that will never exist and then
  // reports success.

  it('the gate reopens for the rest of the run once a create tool is called', () => {
    const defs = [{ name: 'file_read' }, { name: 'image_generate' }, { name: 'video_generate' }]
    const ask = 'build me a landing page for my bakery'
    expect(gateCreateTools(defs, ask).map((d) => d.name)).toEqual(['file_read'])
    expect(gateCreateTools(defs, ask, true).map((d) => d.name)).toEqual(
      ['file_read', 'image_generate', 'video_generate'],
    )
  })

  it('useCodex flips it on the call itself, not on the offered list', () => {
    // A6 leaves the callsite shape alone and only widens the predicate; the
    // patch that turns CREATE_TOOLS into isGatedTool is a one-liner, so this
    // accepts either spelling and still fails if the flip disappears.
    expect(src).toMatch(/if \((?:CREATE_TOOLS\.includes\(name\)|isGatedTool\(name\))\) createGateOpened = true/)
    // Declared per run, so one run's discovery does not leak into the next.
    expect(src).toMatch(/let createGateOpened = false/)
  })

  it('the self-heal covers the two tools A6 gated, by name and run-wide', () => {
    // Same hole, same cure: a run that turns out to be a PR after all, or that
    // decides at step six to fan out, must get the schema back rather than
    // calling blind for the remaining twenty steps.
    const defs = [{ name: 'file_read' }, { name: 'pr_resume' }, { name: 'delegate_task' }]
    const ask = 'clean up the parser'
    expect(gateCreateTools(defs, ask).map((d) => d.name)).toEqual(['file_read'])
    // Per-name reopening: only the tool that actually ran comes back.
    expect(gateCreateTools(defs, ask, ['pr_resume']).map((d) => d.name)).toEqual(['file_read', 'pr_resume'])
    // The run-wide boolean the current callsite passes opens everything.
    expect(gateCreateTools(defs, ask, true).map((d) => d.name)).toEqual(
      ['file_read', 'pr_resume', 'delegate_task'],
    )
  })

  it('isGatedTool nennt genau die sieben Torwerkzeuge und nichts, was immer faehrt', () => {
    // Seit 2.6.8 sieben: die drei Erzeuger, pr_resume, delegate_task und
    // dessen zwei Begleiter. Die Liste steht hier ausgeschrieben und wird
    // NICHT aus GATE_KEYWORDS abgeleitet — sonst pruefte sie eine Karte gegen
    // sich selbst und waere fuer jeden kuenftigen Eintrag automatisch gruen.
    const TOR = [...CREATE_TOOLS, 'pr_resume', 'delegate_task', 'check_tasks', 'message_agent']
    for (const n of TOR) expect(isGatedTool(n), n).toBe(true)
    for (const n of ['file_read', 'file_edit', 'shell_execute', 'todo_write', 'web_search']) {
      expect(isGatedTool(n), n).toBe(false)
    }
    expect([...GATE_OPENING_TOOLS].sort()).toEqual([...TOR].sort())
  })

  it('a closed gate still tells the model the hatch is there', () => {
    expect(src).toContain('const CODEX_ASSET_HINT')
    expect(src).toContain('They are not in your tool list until you do, and the call still works.')
    expect(src).toMatch(/: `\\n\$\{CODEX_ASSET_HINT\}`/)
  })
})

describe('the English words for the thing are in the list too', () => {
  // 'foto' and 'grafik' were there, 'photo' and 'graphic' were not, and the
  // match is a substring test, so neither German entry covers its English
  // twin. On the cloud path a missed keyword is a lost capability.
  it.each([
    'add a photo of the product',
    'I need a graphic for the header',
    'generate a photo-realistic hero',
  ])('%s wants the generators', (ask) => {
    expect(wantsMediaTools(ask)).toBe(true)
    expect(gateCreateTools([{ name: 'image_generate' }], ask).length).toBe(1)
  })

  it('a plain refactor still gets none of them', () => {
    const defs = [{ name: 'image_generate' }, { name: 'video_generate' }, { name: 'run_workflow' }]
    expect(gateCreateTools(defs, 'rename the handler and update its callers')).toEqual([])
  })
})
