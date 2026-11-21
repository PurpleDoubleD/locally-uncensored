// Models LU no longer offers for download (Davids Entscheidung, 21.11.2026).
//
// The licenses of MiniMax H3 and MiniMax H3 Image exclude the EU, the UK,
// South Korea and the USA, derivatives such as FastH3 included. LU does not
// fetch these files any more, on any path. A user who has them keeps them:
// recognising them and running them stays as it was, and LU deletes nothing.
//
// One reader for every way a file could be fetched (api/discover.ts) and for
// the workflow check (lib/workflow-inspect.ts). A repack under a name that
// says nothing of H3 cannot be told by its name; the header sniff still runs
// such a file once it is on disk.

const RETIRED = /minimax[_-]?h3|fasth3/i

/** Does this file name or address belong to a model LU no longer fetches? */
export function isRetiredModelName(text: string | null | undefined): boolean {
  return !!text && RETIRED.test(text)
}

/** What a stopped download, or a run that misses a file, says. */
export const RETIRED_MODEL_LINE = 'LU no longer offers MiniMax H3 for download because of its license. Files you already have keep working.'
