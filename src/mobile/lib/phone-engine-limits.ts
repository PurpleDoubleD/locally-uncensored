// The phone engine (llama-cpp-2 0.1.154) is older than Inkling 2 Mini and cannot
// load it. The name stops a download before gigabytes arrive. An imported file
// with another name is refused by its GGUF head in engine_inproc.rs, with the
// same sentence.

export const REMOTE_ONLY_MODEL =
  'Inkling 2 Mini does not run on this phone. Use it through Remote from your computer.'

export function isRemoteOnlyModel(...names: Array<string | null | undefined>): boolean {
  return names.some((name) => !!name && /inkling[-_ ]?2/i.test(name))
}
