// Which catalogue entries may stand under "Start here".
//
// The three picks are scored from the catalogue's own flags and the fit to
// this machine. Nothing in the score asked how an entry is fetched, so on a
// machine that runs the LU Engine alone the first row recommended "Qwen 3.8
// 27B (Ollama)": an entry only Ollama can pull, whose Get answers that Ollama
// is not set up (persona walk, 09.10.2026, Fund 18). A first recommendation
// has to be one the machine can act on.
//
// "Ollama is not there" is one question on every platform: is the Ollama
// provider on. It is off on a fresh install, the start-up detector turns it
// on when it finds Ollama, and the user's own No keeps it off. It is the
// very condition under which Get refuses such an entry
// (lib/text-download-target ollamaOnlyDownloadBlock).
//
// The entry stays in the list below, with its name saying what it needs.
//
// An entry can also be held back by the catalogue. Picks tie often and the
// newest release wins a tie, so a brand-new model would take the first place
// without anyone having chosen it. Inkling 2 Mini is held back this way while
// its runs on Windows and the standing of its usage policy are open.

/** An entry that is pulled by its Ollama tag and has no file of its own. */
export function needsOllama(model: { ollamaModel?: string }): boolean {
  return !!model.ollamaModel
}

/** Whether this entry may be a "Start here" pick. */
export function mayBeStartHerePick(model: { ollamaModel?: string; notFirstPick?: boolean }, host: { ollamaEnabled: boolean }): boolean {
  if (model.notFirstPick) return false
  return !(needsOllama(model) && !host.ollamaEnabled)
}
