/**
 * What ships as Beta, in one list.
 *
 * 09.10.2026, for 3.0.6: everything that is not finished to the last
 * proof by release day is marked Beta, clearly, at the place where the
 * customer switches it on or meets it for the first time. One word for all of
 * it ("Beta"; the older "Experimental" is gone), one mark (ui/BetaMark), and
 * this list.
 *
 * A feature leaves Beta by deleting its line here. The mark then draws
 * nothing wherever it stands; the call sites named in
 * lib/__tests__/beta-marks.test.ts can be cleaned up after that.
 *
 * The sentence is the hover text of the mark. It says what Beta means for
 * this feature, in plain words, and what the customer should do about it.
 */
export type BetaFeature = 'computer-control' | 'voice' | 'create-in-chat' | 'direct-models' | 'style-training'

export const BETA_LABEL = 'Beta'

export const BETA_FEATURES: Partial<Record<BetaFeature, string>> = {
  'computer-control':
    'Beta: computer control is new and not proven in every app yet. Watch what it does, and stop it when it goes wrong.',
  voice:
    'Beta: Voice is new. It runs on the computers we tested, and yours may still show rough edges.',
  'create-in-chat':
    'Beta: Create in chat is new. A small chat model often gets an order wrong, so read the order before you press Start.',
  'direct-models':
    'Beta: these models are new in LU Cloud. How they hold up when many people use them at once is not measured yet.',
  // 3.0.9 P8 (David, 29.10.2026): the style mode runs, but a short run did
  // not learn a clear style in our test. More steps are not measured yet.
  'style-training':
    'Beta: style training is new. A short run may change the look only a little, so try Standard or Thorough and compare with the LoRA off.',
}

/** The hover sentence of a feature that is still Beta, null once it is not. */
export function betaNote(feature: BetaFeature): string | null {
  return BETA_FEATURES[feature] ?? null
}

/**
 * Computer control on a Mac, said in the open at the switch and in the card
 * that asks for it: it stays in the app, and it is not tested through there.
 * Null on every other system, where the Beta sentence above is the whole truth.
 */
export const COMPUTER_CONTROL_MAC_NOTE =
  'On a Mac, computer control is not fully tested yet. It may miss a click or fail to start. Watch it closely, and stop it when it goes wrong.'

export function computerControlMacNote(isMac: boolean): string | null {
  return isMac && betaNote('computer-control') ? COMPUTER_CONTROL_MAC_NOTE : null
}
