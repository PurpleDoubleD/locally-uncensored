  // ── Caveman prompts (parity with desktop) ──
  var CAVEMAN_PROMPTS = {
    lite: 'Be concise and direct. Drop filler words (just, really, basically, actually, simply), hedging, and pleasantries. Retain full grammar and articles. Keep code blocks, file paths, URLs, and commands unchanged. Every response follows this style.',
    full: 'Respond terse like smart caveman. All technical substance stay. Only fluff die. Drop: articles, filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms preferred. Code unchanged. Pattern: [thing] [action] [reason]. [next step]. ACTIVE EVERY RESPONSE.',
    ultra: 'Maximum brevity. Fewest possible words. Telegraphic. Abbreviate (DB/auth/config/fn/impl/req/res). Strip conjunctions. Arrows for flow (X -> Y). No articles, no filler, no pleasantries. Fragments only. Under 3 sentences unless code. Code/paths/URLs unchanged. ACTIVE EVERY RESPONSE.'
  };
  var CAVEMAN_REMINDERS = {
    lite: '[Be concise. No filler.]',
    full: '[Terse. Fragments OK. No fluff.]',
    ultra: '[Max brevity. Telegraphic.]'
  };
/*@@LU_TOOLING_ONLY@@*/
// Cut out by src-tauri/build.rs: a classic <script> cannot carry `export`.
// It is here so the tests import the shipped constants instead of keeping a
// second copy of them — the copy is what let the two drift apart.
export { CAVEMAN_PROMPTS, CAVEMAN_REMINDERS }
/*@@LU_END@@*/
