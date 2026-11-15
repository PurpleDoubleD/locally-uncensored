/**
 * B4 (2026-08-04): "what is new" once per VERSION.
 *
 * The whole feature is one decision, and it has exactly one trap: a null flag
 * means two different things. A fresh install has never stored one, and so does
 * anyone upgrading from a build that predates the store. Show the popup on both
 * and every new customer is greeted by release notes for software they have
 * never used. Suppress it on both and no upgrade ever sees it. So the rule
 * needs a second signal, and this file is where that is pinned down.
 *
 * Run: npx vitest run src/stores/__tests__/releaseNotesStore.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useReleaseNotesStore, shouldShowReleaseNotes } from '../releaseNotesStore'
import { RELEASE_NOTES, releaseNoteFor, itemDetail, SHEET_CATALOGUE_MODELS, SHEET_CHAT_MODELS, SHEET_MARKED_MODELS } from '../../lib/release-notes'
import { CLOUD_PITCH, CLOUD_REFUSAL_LINE, CLOUD_SUBSCRIBER_LINE, cloudSalesLines } from '../../lib/cloud-pitch'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** A version that really has notes, read from the table rather than hardcoded. */
const KNOWN = RELEASE_NOTES[0].version
const UNKNOWN = '9.9.9'

beforeEach(() => useReleaseNotesStore.setState({ lastNotesVersion: null }))

/**
 * The long, guard-bound text of every line, headline included, regardless of
 * whether a line is still the historic plain string or carries a `title`
 * alongside its `detail` (Runde 2, 19.09.2026). This is what every anchor
 * below matches against, so a title never has to repeat the anchor text: the
 * detail underneath it still does.
 */
function proseOf(version: string): string {
  const note = releaseNoteFor(version)
  return [
    note?.headline ?? '',
    ...(note?.lines ?? []).map(itemDetail),
    ...(note?.details ?? []).flatMap((s) => s.items).map(itemDetail),
  ]
    .join('\n')
    .toLowerCase()
}

describe('the notes table', () => {
  it('has at least one entry, so the rest of this file means something', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0)
    expect(releaseNoteFor(KNOWN)).toBeDefined()
    expect(releaseNoteFor(UNKNOWN)).toBeUndefined()
  })

  it('every entry has a headline and at least two lines', () => {
    for (const n of RELEASE_NOTES) {
      expect(n.headline.trim().length, `${n.version}: headline`).toBeGreaterThan(10)
      expect(n.lines.length, `${n.version}: lines`).toBeGreaterThanOrEqual(2)
      for (const l of n.lines) expect(itemDetail(l).trim().length, `${n.version}: empty line`).toBeGreaterThan(0)
    }
  })

  it('every line of the shipping entry has a title, and no title is a text wall', () => {
    // Runde 2 (19.09.2026): the sheet used to show 35 developer paragraphs
    // with nothing to skim. Every line of the SHIPPING version now has to
    // carry a short `title`, or the redesign quietly regresses to walls of
    // text the next time someone appends a line without writing one. Older
    // entries are exempt: they were written before `title` existed and fall
    // back to their own long text on the sheet, which is the documented,
    // backward-compatible behaviour, not a gap to close retroactively.
    const shipping = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'),
    ).version as string
    const note = releaseNoteFor(shipping)
    const allItems = [...(note?.lines ?? []), ...(note?.details ?? []).flatMap((s) => s.items)]
    expect(allItems.length, `${shipping}: no lines at all`).toBeGreaterThan(0)
    for (const item of allItems) {
      expect(typeof item, `${shipping}: a line is still a plain string, no title`).toBe('object')
      if (typeof item === 'object') {
        expect(item.title?.trim().length ?? 0, `${shipping}: a line has no title`).toBeGreaterThan(0)
        expect(item.title!.length, `${shipping}: title too long: "${item.title}"`).toBeLessThanOrEqual(90)
      }
    }
  })

  it('no version appears twice', () => {
    const versions = RELEASE_NOTES.map((n) => n.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('THE version being shipped has an entry, and it is the newest one', () => {
    // The table's own rule is that a version without an entry shows no popup.
    // That rule is honest and it is also a trap: the release goes out silent
    // and nobody notices, because nothing fails. 2.6.5 was bumped everywhere
    // on 2026-08-12 while this table still ended at 2.6.4, and the only thing
    // that would have caught it was someone remembering. So the version in
    // package.json is now part of the suite.
    const shipping = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'),
    ).version as string
    expect(releaseNoteFor(shipping), `no release note for ${shipping}`).toBeDefined()
    // Ueber der laufenden Version darf ein ENTWURF stehen, und nur ein
    // Entwurf: alles davor muss eine hoehere Version sein. Damit bleibt die
    // urspruengliche Absicherung (kein stilles Release) und die naechste
    // Notiz kann trotzdem fertig im Baum liegen, bevor jemand die Nummer
    // hochzieht.
    const order = RELEASE_NOTES.map((n) => n.version)
    const at = order.indexOf(shipping)
    expect(at, 'the shipping version is missing from the table').toBeGreaterThanOrEqual(0)
    const cmp = (v: string) => v.split('.').map(Number)
    for (const draft of order.slice(0, at)) {
      const [a, b, c] = cmp(draft)
      const [x, y, z] = cmp(shipping)
      expect(a * 1e6 + b * 1e3 + c, `${draft} sits above ${shipping} but is not newer`)
        .toBeGreaterThan(x * 1e6 + y * 1e3 + z)
    }
  })

  it('the shipping entry covers what actually shipped, not the state it was written in', () => {
    // The existence guard above has a blind spot: an entry written early stays
    // green while the branch moves on, so the shipping note is pinned to the
    // headline features of the release it ships with. For 2.6.8 those are the
    // effort control on reasoning models, GLM 5.3 in the cloud catalogue, the
    // built-in engine renamed to LU Engine, the engine that steps off a taken 8127, the model that stays Installed, the
    // ComfyUI installer that repairs its own environment, the model folder
    // that is finally read, the CivitAI key field, the HIP SDK on Windows with
    // its vram_total mix-up, the Linux packages that name libvulkan1, the
    // Coding Agent working directory, Document Chat in Cloud mode, the prompt
    // history that clears, the side panel that folds away, and the ComfyUI
    // requirements.txt that is named when it cannot be used. Each anchor
    // below names one of them, so a note that forgets one fails here.
    // The house formula for hardware nobody here owns is pinned too: a claim
    // we could not run on real hardware says so in those words.
    // 2.6.9 shipped on top of it, so the 2.6.8 anchors now pin the 2.6.8 entry
    // by version and the shipping entry gets its own list below.
    const shipping = '2.6.8'
    const prose = proseOf(shipping)
    for (const anchor of [
      'effort', 'glm 5.3', 'installed', 'lu engine', '8127',
      'repair environment', 'model storage', 'civitai', 'hip sdk',
      'vram_total', 'libvulkan1', 'working directory', 'document chat',
      'prompt history', 'side panel', 'researched rather than proven', 'apple music', 'too big to scan',
      'requirements.txt',
      // A14 third review: "moves to a free port when 8127 is taken" reads on
      // its own as if the engine then lives there. It does not, and the note
      // has to say which one of the two it is.
      'begins at 8127 again',
      // A16 (A14-3a): the trip back to LM Studio is new visible behaviour, so
      // it is in the note and pinned here.
      'the way back is one click',
      // A16 counter-check follow-up: the Ollama half of the same paragraph
      // said the way back was "the provider card it always was". Ollama has a
      // slot of its own and never leaves the picker, so the way back is a
      // click, and sending a reader to Settings for it is a wrong instruction.
      'never leave the picker',
      // Discord-Ticket 007 (a user, 01.09.): der Startfehler schickte ihn
      // in eine Reparatur, die den Fehler gar nicht beheben kann. Beide
      // Haelften gehoeren in die Notiz, die Ursache UND dass die Reparatur
      // hier nicht mehr von selbst anlaeuft.
      'the folder repair rebuilds',
      'a repair that cannot fix it',
      // Discord-Ticket 003 (03.09.): sein Windows-Benutzername
      // steht ausserhalb des englischen Alphabets. Die Zahl bleibt mit
      // Bezugspunkt, eine von acht, sonst sagt sie nichts.
      'one step out of eight',
      // Reddit (02.09.): AMD-Karte gefunden, Groesse nicht.
      // Der Grund gehoert dazu, sonst liest es sich wie eine Marotte.
      'without rocm installed',
      'fixed carve-out',
      // AMD-Messung auf echter Hardware (MI325X, 03.09.): aus "ungeprueft"
      // wird "gemessen", und die zwei Funde, die nur echte Hardware liefert.
      'measured on a rented amd instinct card',
      'processing accelerator rather than as graphics',
      'its gfx target was thrown away',
      // Und die Zeile im Ausgabefenster, die die falsche Hardware nannte.
      'no nvidia driver detected',
      'reporting no usable card',
      // Persona-Lauf 03.09.: deutsche Alltagssaetze erreichten die Werkzeuge
      // nicht. Beide Faelle sind benannt, weil ein Kunde nur den Effekt sieht.
      'schau im netz nach',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
    // And the wrong instruction itself, named so it cannot quietly return.
    expect(prose, 'the note sends Ollama users to the provider card again')
      .not.toContain('the way back to ollama is the provider card')
  })

  it('the 2.6.9 entry names the rollback, the context menu and the Linux self-heal', () => {
    // Same blind spot, next release: the shipping note is pinned to what
    // 2.6.9 actually carries. Two Discord complaints about the wheel (the
    // tools moved, the edge was cut off), the context menu the owner saw clipped
    // himself, the AUR customer whose update asked for a password and died,
    // the teaser that names the card's own VRAM, and the per-account count of
    // the Cloud switch, which is new telemetry and therefore said out loud.
    // 3.0.0 shipped on top of it, so these anchors pin the 2.6.9 entry by
    // version and the shipping entry gets its own list below.
    const shipping = '2.6.9'
    const prose = proseOf(shipping)
    for (const anchor of [
      'back to the 2.6.7 layout', 'nothing is cut off', 'opens upwards',
      'signed appimage', 'without a password', 'pacman, dpkg and rpm',
      'system password prompt', 'how much vram your own gpu has', 'hosted checkout',
      'counted per account',
      // The limitation 2.6.8 announced is still there, so it is still said.
      'stays stopped until you press use',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
    // 2.6.8 promised the engine would come back on its own in 2.6.9. It does
    // not, so no entry may keep that promise alive.
    for (const version of ['2.6.8', '2.6.9']) {
      expect(proseOf(version), `${version} still promises the engine fix for 2.6.9`)
        .not.toContain('2.6.9 brings the engine back')
    }
  })

  it('the 3.0.0 entry names the measurement, the free Flash chat, the policy, the fixes and the open card', () => {
    // Same blind spot, next release. The measurement says how many models
    // carry the mark and that the newest one does not yet; Flash chat names
    // its ceiling and that keys keep paying; the policy names the age step;
    // and every fix merged on 11.09. (trainer, engine log and layers, the way
    // back out of the cloud, Stop, Stop per chat, Code tab, the max tokens
    // field, custom backend context and its running window, download
    // progress) gets an anchor, plus the one report that stays open because
    // nobody here owns the card.
    // 3.0.1 shipped on top of it (package.json), so this pins the 3.0.0 entry
    // by its own version like the 2.6.8 and 2.6.9 blocks above do, and the
    // 3.0.1 entry gets its own anchors below.
    const shipping = '3.0.0'
    const prose = proseOf(shipping)
    for (const anchor of [
      'without refusing', 'we asked them', 'carries no mark yet',
      'no credits', '500,000', 'api keys always pay',
      'content policy', 'decided by the server', 'animate button', 'sampling controls',
      'libuv', 'exit code', 'runs on the cpu', 'stop means stop',
      'why a folder was refused', 'cut off at the token limit',
      'real context window', 'no guessed budget', '2 gb card',
      // Welle 6, gemessen und gebaut am 11.09.: jeder Nachtrag im Fixes-Block
      // bekommt seinen eigenen Anker, sonst faellt einer bei der naechsten
      // Ueberarbeitung still heraus.
      'small window above the prompt row', 'an x closes the window',
      'forgets the remembered default', '~/agent-workspace',
      'switching cloud off starts the lu engine again',
      'stop in one chat no longer stops',
      'another chat is still answering',
      'replaces what is in it', '0512',
      'the running one wins', 'shared chunk cache',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
    // The old suffix must not be sold as a feature again.
    expect(prose).not.toContain('(unrestricted)" mark')
    // Kritiker 2, Rang A: drei Saetze des Blatts waren am Auslieferungskopf
    // gemessen falsch. Jeder einzelne wird hier namentlich ferngehalten, denn
    // ein Satz, der einmal zurueckkommt, kommt beim naechsten Zusammenfuehren
    // wieder mit.
    for (const wrong of [
      // Bauer U: die Regler klappen nicht mehr auf, sie sind ein Fenster mit X.
      'collapsed until you want them',
      'sit next to the model picker, collapsed',
      // T4 Punkt 5: der Arbeitsordner-Dialog hat drei Eintraege, keinen zum
      // Vergessen. Vergessen wird ueber das x an der Pille.
      'forgotten in the workspace dialog',
      // Der Messer hat V4.1 Flash gemessen.
      'no mark until it is measured',
      // R6-2: die App verspricht keine Meldung, die sie nicht selbst
      // einloest. Der Block selbst wird
      // davon nicht schwaecher: die Ablehnung steht unveraendert im Satz.
      'and reported',
    ]) {
      expect(prose, `${shipping}: still says "${wrong}"`).not.toContain(wrong)
    }
    // Die Ablehnung bleibt, und die zweite Haelfte des Satzes steht wortgleich.
    expect(prose).toContain('refused on every request')
    expect(prose).toContain('photograph of a real, identifiable person without their consent')
  })

  it('the 3.0.1 entry names its own fixes', () => {
    // Auflage 2 (review-gesamt.md): package.json, Cargo.toml/.lock and
    // tauri.conf.json all moved to 3.0.1 in one commit, so THIS is now the
    // shipping entry the earlier existence guard checks. Same blind spot as
    // 2.6.8/2.6.9/3.0.0 above: an anchor per fix, so a later edit that drops
    // one fails here instead of shipping quietly incomplete.
    // 3.0.2 shipped on top of it (package.json), so this pins the 3.0.1 entry
    // by its own version like the 2.6.8, 2.6.9 and 3.0.0 blocks above do, and
    // the 3.0.2 entry gets its own anchors below.
    const shipping = '3.0.1'
    const prose = proseOf(shipping)
    for (const anchor of [
      'avx2', 'total capacity, not free memory', 'ld_library_path',
      'pythonhome', 'refuses to write into the system python', 'pip call',
      'searches the interpreters already on your machine',
      // Auflage 1 Nachtrag: die Zeilen dieses Berichts.
      'parks the api key it displaces', 'redirects pip, hugging face and torch',
      'animate this image button', 'qwen-image-edit', 'enhance image',
      'krea 2 checkpoints', 'stays disabled instead of failing on the server',
      'failed to fetch', 'distinct title for each of its three reasons',
      'crashes when grouping models', 'top k',
      'survives export and import again', 'blocks the whole sync',
      'composer lock during a send', 'a third remembered agent folder',
      'asks the running engine directly',
      // ENG-14, matrix point 83 (review-venvhint.md): the fix itself was
      // stdout being discarded; this is the sentence the sheet promises for it.
      'python3-venv', 'lu only read stderr',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
  })

  it('the 3.0.2 entry names the Code tab hotfix and the new count', () => {
    // Hotfix fuer Issue 138: package.json, Cargo.toml/.lock and
    // tauri.conf.json all moved to 3.0.2 in one commit, so this was the
    // shipping entry the earlier existence guard checked. Same blind spot as
    // 2.6.8/2.6.9/3.0.0/3.0.1 above: an anchor per statement, so a later edit
    // that drops one fails here instead of shipping quietly incomplete. The
    // two statements are the only two the CHANGELOG carries for 3.0.2.
    // 3.0.3 shipped on top of it (package.json), so this pins the 3.0.2 entry
    // by its own version like the blocks above, and the 3.0.3 entry gets its
    // own anchors below.
    const shipping = '3.0.2'
    const prose = proseOf(shipping)
    for (const anchor of [
      // Der Fehler, sein Bericht und die Version, aus der er stammt.
      'issue 138', 'a regression in 3.0.1', 'scroll container',
      'the mouse wheel did nothing', 'held to the window height again',
      // Und die Grenze der Aussage: der Chat-Reiter war nie betroffen.
      'the chat tab was never affected',
      // Die neue Zaehlung, beide Gattungen und die Herkunft der Marke.
      'fourteen video models', 'seven image models', 'create studio shelf',
      'reported ten and three', 'never from the name',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
  })

  it('the 3.0.3 entry names every fix of the hotfix', () => {
    // Hotfix vom 28.09.2026. 3.0.4 kam darauf (package.json), also pinnt
    // dieser Block den 3.0.3-Eintrag ueber seine eigene Version, wie die
    // Bloecke darueber. Ein Anker pro Fix: eine spaetere Aenderung, die einen
    // verliert, faellt hier auf.
    const shipping = '3.0.3'
    const prose = proseOf(shipping)
    for (const anchor of [
      // Der Chat-Speicher: Ursache, Grenze, Umzug und die Rueckholung.
      'kept inline in the saved chat history', '127 mib', 'moved over once',
      'backup file still held',
      'image previews load only near',
      // Create: Familie aus dem Dateikopf, die neuen Familien, die Reparatur
      // nach einer Frage, und was aus dem Picker faellt.
      'value not in list', 'from the file header', 'chroma', 'hidream i1',
      'sd 3.5', 'lumina 2', 'qwen-image-edit', 'asks once, then downloads',
      'no longer shows up in the model picker',
      // Edit, Galerie, Papierkorb, dunkle Kacheln.
      'strength 1.00', 'stops at 0.95', 'edit drop zone', 'recycle bin',
      'output folder stops growing', 'stay dark until the next start',
      // GitHub 139 bis 143, jede Nummer beim Namen.
      'issue 139', 'measured on a hidden copy',
      'issue 140', 'the blue /loop bar', 'working folder locked',
      'exceeds its context size',
      'issue 141', 'collapsed sidebar',
      'issue 142', 'names no size', 'upright frame',
      'issue 143', 'model storage folder', 'comfyui path not set',
      // Der Agent und sein Arbeitsordner (Discord 28.09.2026).
      'the button next to agent', 'pick a folder', 'no longer says filesystem reaches files anywhere',
      'plain chat has no tool that reads your files', 'says to turn on agent',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
  })

  it('the 3.0.4 entry names every fix', () => {
    // Kundenfall a user, 30.09.2026. 3.0.5 kam darauf (package.json),
    // also pinnt dieser Block den 3.0.4-Eintrag ueber seine eigene Version, wie
    // die Bloecke darueber. Ein Anker pro Fix.
    const shipping = '3.0.4'
    const prose = proseOf(shipping)
    for (const anchor of [
      // Der Abbruch mitten im Schreiben und was jetzt zaehlt.
      'in the middle of the write', 'only when no data arrives at all',
      // "continue" nach Stopp oder Fehler, und das Protokoll der alten Schritte.
      'after a stop or an error', 'short list of what is already done',
      // Plan nur auf Wunsch, dunkle Leiste.
      'in plan mode, when you ask for a plan', 'dark instead of blue',
      // Buendeln und file_edit.
      'several files in one step', 'several places in a file in one call',
      // Kontext.
      '32k of context by default instead of 64k', 'a small triangle',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
  })

  it('the 3.0.6 entry names what it ships', () => {
    // Vorbereitet am 09.10.2026. Der Eintrag ist an seine Nummer gebunden und
    // nicht an package.json: so steht er als Entwurf im Baum, und der Sprung
    // der Version ist ein eigener Commit, der nur die fuenf Dateien mit der
    // Nummer anfasst. Ein Anker pro Punkt.
    const prose = proseOf('3.0.6')
    for (const anchor of [
      // Voice: die Flaeche, die Stimmen, die Schalter, die Stufen.
      'voice is a new surface', 'english only for now', 'alba, anna, azelma', 'where it may work',
      'workspace only is the default', 'whole computer', 'between 128 and 4096 tokens, 512 by default',
      'five minutes after the last session', 'kept for up to a minute', 'smaller than 7b',
      // Voice endet nur bei einem ernsten Fehler.
      'an error it cannot recover from',
      // Computer control: aus bis eingeschaltet, Sperrliste, Kuerzel, Grenze.
      'settings, agent, agent permissions, computer control', 'never types into a password field',
      'ctrl+alt+space pauses and ctrl+alt+esc stops', 'at most 25 steps or 8 minutes', 'at most 24',
      // Heikles nie per Stimme, Pause per Maus und per Wort.
      'a spoken yes never confirms such an action', 'pauses when you move the mouse', 'say stop or wait',
      // Was gemessen ist, steht mit seiner Messung da.
      '11 to 22 seconds', '1 of 3 runs', 'recommended from 16 gb',
      // Statuszeichen, Dialoge, Freigabe, Anbieter-Vorsatz.
      'reading, writing, searching or working on the screen', 'floats above the composer',
      'one dark glass style', 'such as change a file', 'openai::',
      // Cloud: zehn Direktmodelle, die zwei Marken, die Namen der Medienmodelle.
      'ten models whose makers release them', 'are labelled no filter', 'wan 2.2 uncensored extend',
      'fourteen video models and seven image models',
      // Nachtrag 10.10.2026, Umfang von integ/astra-306 4b57e672.
      // Beta: Voice, Computer control, Create im Chat und die Gruppe der neuen
      // Modelle sagen es selbst, mit dem, was es fuer den Kunden heisst. Die
      // Woerter folgen den Hover-Saetzen in lib/beta.ts.
      'voice is in beta', 'computer control is in beta', 'create in chat is in beta',
      'the group is in beta', 'marks them with the word beta',
      'rough edges', 'not proven in every app yet', 'read the order before you start it',
      // Der Bildteil kommt mit, mit den zwei Woertern der Oberflaeche.
      'include image input', 'add image input', '42 image parts',
      // Create im Chat: Schalter, Karte, Freigabe.
      'the plugins menu has a create switch', 'nothing runs until you approve it',
      'switched on account by account',
      // Die Marke im Waehler, in einem Satz.
      'limited capacity',
      // Die Sicherheitspruefung, die Texte zur Privatsphaere, Linux.
      'the ten findings we fixed', 'into a password field', 'eleven more languages',
      'no analytics kit', 'each press of the cloud switch', 'not end to end',
      'appimage, the deb and the rpm for x86_64', 'not started the packaged app',
      // Nachtrag zum Kopf integ/astra-306 5a409bd6: die Erlaubnis je Chat, Bild
      // oder Liste nach dem Modell, die Grenze fuer abgelehnte Aufrufe und das
      // Lesen von Webseiten.
      'allow computer control in this chat', 'a new chat asks again',
      'does not ask how it should run', 'from that list alone',
      'after six the turn ends',
      'packed pages are now readable', '100.64.0.0/10', 'a page over 8 mb is refused',
      // Nachzug 10.10.2026 abends: Ollama, LM Studio, LU Engine, das Senden vor
      // dem stillen Gedaechtnislauf, der Grund beim Modellwechsel, die Funde auf
      // allen Plattformen, die Karte in Voice und die zwei neuen Fragen.
      'part of the model moves to the processor', 'keeps a model loaded for one context window',
      'a load ends after five minutes at the latest', 'without the graphics card', 'waited behind it',
      'stopped because you switched to another model', 'the details dialog names a model once',
      'this one needs your click on the screen', 'alt with a letter', 'it stops at 16 mb',
      'our check in the real app ran on windows',
      // Nachzug 11.10.2026: das Feld Microphone, das Diktat mit PyAV 19, der
      // Bildteil von Hand, die Zusammenfassung mit Codebloecken, Restart Now,
      // der CUDA-Hinweis und die langen LoRA-Namen. Was nur in Tests lief,
      // sagt es, und Restart Now sagt, ab wann es gilt.
      'has a microphone field', 'not yet with a real microphone',
      'metadata_errors', 'needs no reinstall',
      'under its original name', 'no model gets it',
      'inside a code block', 'pull request 154',
      'from the next update after this one', 'not checked it on a real update',
      'comes from the graphics driver', 'as many lines as it needs',
    ]) {
      expect(prose, `3.0.6: nothing about "${anchor}"`).toContain(anchor)
    }
    // Hausregeln fuer den Text: kein Gedankenstrich, kein Anbietername, der
    // Arbeitsname der Funktion steht nirgends, und kein Satz verspricht eine
    // Signatur oder einen Mac-Bau, solange beides nicht am Release haengt.
    expect(prose).not.toMatch(/[\u2013\u2014]/)
    expect(prose).not.toMatch(/wavespeed|deepinfra|venice|astra/)
    // "signed in to LU Cloud" ist die Anmeldung und bleibt erlaubt.
    expect(prose).not.toMatch(/\bsigned\b(?! in\b)|notarized|macos build|\bmac\b/)
    // Der Knopf fuer den Bildteil steht an der Modellzeile und im Chat, nicht
    // mehr in den Einstellungen von Computer control.
    expect(prose).not.toContain('in the computer control settings')
    // Und nichts vom Handy: das kommt mit 3.0.7.
    expect(prose).not.toMatch(/android|iphone|mobile app/)
    // Kein Preis und keine Angabe, was ein Betrag kauft.
    expect(prose).not.toMatch(/\$|\beur\b|€|tokens? (?:per|for) /)
    // Und die Zahl der Modelle ist die des Eintrags: zehn, kein anderes Wort.
    expect(prose).toContain('ten more chat models')
    // Die Cloud steht mit dem da, was die App zeigt, je in einem Satz. Wie
    // gerechnet wird, steht in keinem.
    expect(prose).not.toMatch(/billed|charged|refund|per minute|request limit|share of|booked/)
  })

  it('the 3.0.5 entry still names what it shipped', () => {
    // Create-Umbau, 03.10.2026, released 05.10.2026. Bis zum Sprung auf 3.0.6
    // las dieser Fall die Nummer aus package.json; jetzt haelt er den Eintrag
    // bei seiner Nummer fest, wie die aelteren Faelle darueber.
    const shipping = '3.0.5'
    const prose = proseOf(shipping)
    for (const anchor of [
      // Die neuen lokalen Modelle und ihre ComfyUI-Mindestversionen.
      'ltx 2.5 needs comfyui 0.32.0, fasth3 0.35.0 and yue2 0.36.0', 'small (gguf q4)',
      // Qwen-Image 2.1: Schalter und Prompt Enhancer (GitHub 148).
      'transparent background', 'rewritten by', 'comfyui 0.37.2', 'issue 148',
      // Qwen-Image 2.1 mit dem Text-Encoder ohne Verweigerungen.
      'qwen-image 2.1 (no refusals)', 'which one reads your prompt',
      // Noct Q, der Community-Finetune von Qwen-Image 2.1.
      'noct q (qwen-image 2.1, unfiltered)', 'transformer weights were modified',
      // Shots, LoRA-Staerke, Turbo-LoRA, Marken.
      'shots slider', 'from -10 to 10', 'ready to install', 'older models',
      // Passt das Modell zur Grafikkarte: Model Manager, Waehler, Wartezeile.
      'fits your 12 gb card', 'loading can be slow', 'waiting line says why',
      // Mehrere Bilder in einem Zug, Figur aus einem Video, Prompt umschreiben.
      'up to 50 source images', 'save character', 'improve my prompt',
      // Cloud: neue Modelle, Anzahl, Referenzfotos, Edit ohne Maske.
      'five additions from open model families', 'images slider from 1 to 4', 'up to five photos', 'needs no mask',
      // Chat: Dateien und Persona je Gruppenmodell.
      'up to 3 per message and 64 mb each', 'persona picker',
      // Fixes: Linux-Sprache, Aufklappmenues (GitHub 149), Pruefsumme.
      'faster-whisper and piper', 'issue 149', 'right click menu', 'sha-256',
    ]) {
      expect(prose, `${shipping}: nothing about "${anchor}"`).toContain(anchor)
    }
    // Hausregeln fuer den Text: kein Gedankenstrich, kein Anbietername.
    expect(prose).not.toMatch(/[\u2013\u2014]/)
    expect(prose).not.toMatch(/wavespeed|deepinfra/)
  })

  it('the Flash allowance on the sheet hangs on a RUNNING plan, not on money that once arrived', () => {
    // Entscheid V3 vom 12.09.2026. Das Blatt mass die Freimenge daran, ob je
    // gezahlt wurde ("an account that has never paid"), der Server misst sie
    // seit heute am laufenden Abo. Ein gekuendigtes Abo las auf dem Blatt also
    // weiter eine Zusage, die es nicht mehr bekommt. Der Satz steht hier
    // zeichengleich mit der Kaufseite im Web.
    const prose = proseOf('3.0.0')
    expect(prose, 'the sheet does not carry the decided Flash sentence').toContain(
      `${CLOUD_PITCH.flashModels} of the ${CLOUD_PITCH.chatModels} models in the catalogue cost no credits at all`
      + ' in chat on an active paid plan, up to 500,000 input and output tokens per day.'
      + ' api keys keep paying credits, and accounts without an active plan keep paying credits too.',
    )
    expect(prose, 'the sheet still measures the benefit by whether money ever arrived')
      .not.toMatch(/never paid/)
    expect(prose, 'the detail line still measures it that way').toContain('benefit of an active paid plan')
  })

  it('the model numbers on the 3.0.0 sheet are read from the catalogue, never typed', () => {
    // Der Fund, der diesen Waechter erzwungen hat: das Blatt sagte "27 of the
    // 46", waehrend das Freigabe-Tor auf DEMSELBEN Commit "27/47 chat"
    // ausgab. Eine Zahl in der Prosa kann nicht laut falsch sein, sie sitzt
    // einfach da, nachdem der Katalog weitergezogen ist.
    //
    // Darum zwei Haelften. Erstens: die Saetze werden aus den Konstanten
    // gebaut, ein falsch getippter Nenner faellt hier auf. Zweitens: der
    // Quelltext darf die Form "N of the N" gar nicht mehr enthalten, sonst
    // liesse sich auch die HEUTE richtige Zahl wieder eintippen und bliebe
    // stehen, wenn der Katalog sich bewegt.
    const prose = proseOf('3.0.0')
    // R2-10 und R6-5: der Nenner der Marke ist der MESSLAUF, nicht der
    // Katalog. 27 von 47 behauptete, 20 Katalogmodelle seien gemessen worden
    // und durchgefallen; gemessen wurden 46, und V4.1 Flash kam danach dazu.
    // Der Katalog steht weiter im Blatt, aber in einem eigenen Halbsatz.
    expect(SHEET_CHAT_MODELS, 'the mark denominator is the measurement run')
      .toBe(CLOUD_PITCH.measuredChatModels)
    expect(SHEET_CATALOGUE_MODELS, 'the catalogue half-sentence counts the catalogue')
      .toBe(CLOUD_PITCH.chatModels)
    expect(SHEET_MARKED_MODELS, 'sheet mark count is not the measured one')
      .toBe(CLOUD_PITCH.unfilteredChatModels)

    // R2-11: der Waechter baut seinen eigenen Satz aus denselben zwei
    // Konstanten. Vorher stand der Nenner des Katalogs darin, der Waechter
    // haette den falschen Nenner also mitgetragen statt ihn zu melden.
    const phrase = `${CLOUD_PITCH.unfilteredChatModels} of the ${CLOUD_PITCH.measuredChatModels}`
    expect(phrase).toBe('13 of the 36')
    // Entscheid vom 12.09.2026: EIN Satz traegt die Aussage, und er sagt
    // "in full". Vorher standen zwei Saetze mit zwei Formulierungen derselben
    // Messung auf demselben Blatt, einer im Kurztext, einer im Ausklapper.
    const satz = `${phrase.toLowerCase()} cloud chat models we measured answer in full without refusing, and only those carry the no refusals mark.`
    expect(prose, 'the sheet does not carry the one mark sentence').toContain(satz)
    expect(prose.split(satz).length - 1, 'the mark sentence stands exactly once').toBe(1)
    expect(prose, 'the loose wording of the mark claim is back')
      .not.toContain(`${phrase.toLowerCase()} answer in full.`)
    expect(prose, 'the catalogue denominator is back on the mark sentence')
      .not.toContain(`${CLOUD_PITCH.unfilteredChatModels} of the ${CLOUD_PITCH.chatModels}`)

    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/release-notes.ts'), 'utf8',
    )
    const typed = [...src.matchAll(/\d+ of the \d+/g)].map((m) => m[0])
    expect(typed, 'a model count typed into the sheet instead of read from CLOUD_PITCH')
      .toEqual([])
    const interpolations = src.split('${SHEET_MARKED_MODELS} of the ${SHEET_CHAT_MODELS}').length - 1
    expect(interpolations, 'the one mention has to come from the constants').toBe(1)
    // R2-45 und R5-44: keine ausgeschriebene Zahl und keine getippte
    // Tausenderzahl mehr. Beide standen als Prosa neben derselben Zahl aus
    // CLOUD_PITCH und konnten still auseinanderlaufen.
    // Eng gefasst auf die Stelle, die getippt danebenstand: die Flash-Zahl als
    // Zahlwort vor "models" oder "of those". Ein blankes /Twelve/ traefe auch
    // die zwoelf Sekunden der Ladephase, die mit keinem Katalog wandern.
    expect(src.match(/\bTwelve\b\s+(models|of those)/i),
      'the flash model count written out instead of read').toBeNull()
    expect(src.match(/\d{1,3}(,\d{3})+/), 'a token ceiling typed instead of read').toBeNull()
  })

  it('says nothing in the shipping note twice, word for word', () => {
    // A14 third review: "The built-in engine is called LU Engine from now on."
    // stood in `lines` and again in `details.Local`, identical to the letter.
    // Two copies of one sentence drift apart at the next edit, and until they
    // do, the reader meets the same statement twice in one popup. The summary
    // lines are a summary; the details are the detail.
    const shipping = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'),
    ).version as string
    const note = releaseNoteFor(shipping)
    // Long sentences only: a short one can legitimately repeat.
    const sentences = (text: string) =>
      text.split(/(?<=\.)\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 30)
    const inLines = new Set((note?.lines ?? []).map(itemDetail).flatMap(sentences))
    const repeated = (note?.details ?? [])
      .flatMap((s) => s.items)
      .map(itemDetail)
      .flatMap(sentences)
      .filter((x) => inLines.has(x))
    expect(repeated, 'said word for word in both places').toEqual([])
  })

  it('every file that carries the version carries the same one', () => {
    // package-lock.json sat at 2.6.2 for three releases while everything else
    // moved, because a version bump touches four files and only three of them
    // are obvious. It does not change the built app, but it is the file a
    // packager reads, and a wrong number here is a wrong number in a bug report.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const shipping = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
    expect(lock.version, 'package-lock.json root').toBe(shipping)
    expect(lock.packages?.['']?.version, 'package-lock.json self entry').toBe(shipping)
    const tauri = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    expect(tauri.version, 'tauri.conf.json').toBe(shipping)
    const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8')
    expect(cargo, 'Cargo.toml').toContain(`version = "${shipping}"`)
  })

  it('2.6.3 carries full details with a Local and a Cloud section', () => {
    const note = releaseNoteFor('2.6.3')
    const titles = (note?.details ?? []).map((s) => s.title)
    expect(titles).toContain('Local')
    expect(titles).toContain('Cloud')
    for (const s of note?.details ?? []) {
      expect(s.items.length, `${s.title}: items`).toBeGreaterThanOrEqual(3)
      for (const i of s.items) expect(itemDetail(i).trim().length, `${s.title}: empty item`).toBeGreaterThan(0)
    }
  })

  /**
   * 13.09.2026: das Blatt fuehrt mit dem Cloud-Block.
   *
   * Der Block ist die einzige Stelle, an der ein BESTEHENDER Kunde nach einer
   * Aktualisierung vom Angebot erfaehrt, also steht er vor allem anderen und
   * faellt staerker aus als der Rest. Seine Zahlen sind dieselben Konstanten
   * wie im Verkaufs-Panel am Schalter; zwei Fassungen derselben drei Zahlen
   * waeren genau der Fund, den dieser Waechter seit R2-11 fernhaelt.
   */
  it('the sheet leads with the Cloud block, and it is read, never typed', () => {
    const note = releaseNoteFor('3.0.0')
    expect(note?.cloud, 'the 3.0.0 sheet carries no Cloud block').toBeDefined()
    expect(note!.cloud!.lines, 'the block writes its own version of the three lines')
      .toEqual(cloudSalesLines())
    // Nachtrag a: der Messsatz steht im selben Block wie im CHANGELOG, aus
    // derselben Konstante, damit die zwei Flaechen nicht auseinanderlaufen.
    expect(note!.cloud!.measured, 'the sheet carries no measured refusal sentence')
      .toBe(CLOUD_REFUSAL_LINE)
    expect(note!.cloud!.note, 'the subscriber sentence is not the shared one')
      .toBe(CLOUD_SUBSCRIBER_LINE)

    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/release-notes.ts'), 'utf8',
    )
    expect(src).toContain('lines: cloudSalesLines()')
    expect(src).toContain('note: CLOUD_SUBSCRIBER_LINE')

    const modal = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/release/ReleaseNotesModal.tsx'),
      'utf8',
    )
    expect(modal).toContain('release-cloud-block')
    expect(modal, 'the block has no way into the cloud').toContain('Turn on Cloud')
    // Vor allem anderen: der Block steht im Quelltext vor der restlichen
    // Prosa des Blatts.
    //
    // Runde 2 (19.09.2026): "What is new" plus ein separates Versions-Label
    // wichen "What's new in {version}" in der FESTEN Kopfzeile (Logo und
    // Ueberschrift bleiben beim Scrollen sichtbar, wie Version und Logo es
    // vorher schon taten) und stehen darum vor JEDEM Inhalt, auch vor dem
    // Cloud-Block. Das ist kein Verstoss gegen "vor allem anderen": der
    // Massstab war immer der INHALT, nicht das Chrome. Der Marker fuer den
    // ersten echten Inhaltssatz ist jetzt `release-intro`, das Gegenstueck zur
    // fruehen "What is new</h3>"-Ueberschrift im Koerper.
    expect(modal.indexOf('release-cloud-block'))
      .toBeLessThan(modal.indexOf('data-testid="release-intro"'))
    // Der Knopf faellt auf denselben Weg zurueck wie der Schalter im Kopf.
    expect(modal).toContain("setCloudGateOpen(true, 'release-notes')")
    expect(modal).toContain("updateSettings({ appMode: 'cloud' })")
  })

  it('and the rest of the sheet is unchanged, to the character', () => {
    // Der Cloud-Block ist ein eigenes Feld und darf NICHT in die Prosa
    // gerutscht sein: sonst haette er die Anker oben verschoben, und die
    // bestehenden Saetze waeren nicht mehr zeichengleich.
    const prose = proseOf('3.0.0')
    expect(prose, 'the Cloud block leaked into the sheet prose')
      .not.toContain('chat models with no refusals')
    expect(prose, 'the subscriber sentence leaked into the sheet prose')
      .not.toContain('more credits per euro')
  })

  it('the modal renders every section and lets a line disclose its own detail', () => {
    // Source guard, same pattern as the settings guards: the sheet must map
    // note.details and section.items, or the table above is dead data.
    //
    // Runde 2 (19.09.2026): the one global "Show all changes" switch is gone,
    // replaced by a per-line disclosure (aria-expanded) plus an "Expand all"
    // convenience that opens every one of them at once. Both are pinned here
    // so a later edit cannot quietly bring back one wall of always-visible
    // text.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/release/ReleaseNotesModal.tsx'),
      'utf8',
    )
    expect(src).toContain('note.details.map')
    expect(src).toContain('section.items.map')
    expect(src).toContain('aria-expanded')
    expect(src).toContain('Expand all')
    expect(src, 'the old global switch is back').not.toContain('Show all changes')
  })
})

describe('shouldShowReleaseNotes', () => {
  it('shows for an upgrade from a build that had no store yet', () => {
    // The 2.6.2 to 2.6.3 case: onboarding was done long ago, the flag is null
    // because this store did not exist there.
    expect(shouldShowReleaseNotes(KNOWN, null, true)).toBe(true)
  })

  it('shows for an upgrade from a version whose notes were already read', () => {
    expect(shouldShowReleaseNotes(KNOWN, '2.6.0', true)).toBe(true)
  })

  it('does NOT show again once this version was seen', () => {
    expect(shouldShowReleaseNotes(KNOWN, KNOWN, true)).toBe(false)
  })

  it('does NOT show while onboarding is still running', () => {
    // This is the fresh-install guard. Onboarding owns the whole screen, and
    // finish() stamps the current version, so a new user never reaches the
    // "null means upgraded" branch above.
    expect(shouldShowReleaseNotes(KNOWN, null, false)).toBe(false)
  })

  it('stays quiet for a version nobody wrote notes for', () => {
    // A release that ships without notes shows no sheet rather than a headline
    // with nothing under it.
    expect(shouldShowReleaseNotes(UNKNOWN, null, true)).toBe(false)
    expect(shouldShowReleaseNotes(UNKNOWN, '2.6.0', true)).toBe(false)
  })
})

describe('the fresh-install sequence end to end', () => {
  it('a new user who finishes onboarding never sees the notes for that build', () => {
    const store = useReleaseNotesStore.getState()
    // Before onboarding finishes: nothing stored, nothing shown.
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, false)).toBe(false)
    // Onboarding.finish() does exactly this.
    store.markNotesSeen(KNOWN)
    // Now onboarded, and the sheet stays down.
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, true)).toBe(false)
  })

  it('that same user DOES see the notes for the next version', () => {
    useReleaseNotesStore.getState().markNotesSeen(KNOWN)
    // Pretend the next build ships with its own entry.
    expect(useReleaseNotesStore.getState().lastNotesVersion).toBe(KNOWN)
    expect(shouldShowReleaseNotes(KNOWN, KNOWN, true)).toBe(false)
    // A different current version with notes would show; proven with the table
    // entry itself so this cannot pass on a typo.
    expect(shouldShowReleaseNotes(KNOWN, 'something-older', true)).toBe(true)
  })

  it('dismissing stamps the version so it does not return', () => {
    expect(shouldShowReleaseNotes(KNOWN, null, true)).toBe(true)
    useReleaseNotesStore.getState().markNotesSeen(KNOWN)
    expect(shouldShowReleaseNotes(KNOWN, useReleaseNotesStore.getState().lastNotesVersion, true)).toBe(false)
  })
})

describe('the notes describe what actually shipped', () => {
  // The 2.6.5 sheet claimed "A refused tool call ends the run at once and says
  // why, instead of the agent carrying on as if it had permission." The commit
  // it was written for (7110df26) changes how an HTTP 4xx from the MODEL
  // SERVER is classified. Nothing in the release touches tool permissions, so
  // the one line most likely to be read as a fix for the approval flow
  // promised something that is not in the build (review 2026-08-14).
  const notesSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/release-notes.ts'), 'utf8',
  )
  const changelog = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../CHANGELOG.md'), 'utf8',
  )

  it('does not promise a tool-permission fix this release does not contain', () => {
    expect(notesSrc).not.toContain('as if it had permission')
    expect(changelog).not.toContain('as if it had permission')
  })

  it('says what the 4xx change really does, in both places', () => {
    expect(notesSrc).toContain('A request the model server refuses ends the run at once')
    expect(changelog).toContain('A request the model server refuses ends the run at once')
  })
})
