import { test, expect } from '@playwright/test'
import { Rec, HOWTO_OUT } from './rec'

// Train a character on a Mac (3.0.7). Recorded on integ/307 (ddeccc9ce) with
// platform 'mac' in Local mode. Facts, all from that head:
//  - SpecialIntentControls.tsx CharacterPanel: on a Mac in Local mode the
//    Train new tab is MacTrainControls (isMlxImageHost), no longer a note
//    that training does not run on a Mac.
//  - SpecialIntentControls.tsx MacTrainControls: without the image engine and
//    Z-Image Turbo it reads "Training on this Mac needs Z-Image
//    Turbo. Install it in the Model Manager first, then come back here."
//    With them: the field "Trigger word, e.g. davechar", the lengths Quick,
//    Standard, Thorough (lib/trainer-presets.ts TRAIN_PRESETS: 400, 1200,
//    2400 steps, Standard the default) and the count "<n>/100 photos".
//  - api/mlx-train.ts macTrainNote: the line under it reads "Runs on this Mac
//    and takes a while (<length>, <steps> steps). The local chat model pauses
//    for the run. The first run also downloads a 340 MB training adapter.
//    The character lands in your LoRA folder." with "Open the LoRA folder".
//    The adapter part only while the adapter is not on disk.
//  - src-tauri commands/mlx_train.rs: MIN_PHOTOS 4, MAX_PHOTOS 100, the
//    result is char_<trigger>_zimage.safetensors in the Mac's LoRA folder;
//    lib/train-image-cap.ts maxTrainImages('local') 100, MIN_TRAIN_IMAGES 4.
//  - Stage.tsx TrainSetBoard: the empty board reads "Drop 4 to 100 photos of
//    your character here". On a local backend (a Mac included) every photo
//    has a field "What changes in <file>" (placeholder "e.g. red jacket,
//    short hair, beach") under the help line TRAIN_CAPTION_HELP
//    (lib/train-captions.ts). hooks/useCreate.ts runCharacterTraining puts
//    it into that photo's caption after the trigger word (buildTrainCaption:
//    "<trigger>, a photo of <trigger>, <text>"); api/trainer.ts hands the
//    caption to stageMacTrainPhoto on a Mac.
//  - Not shown: a run. Per the 3.0.7 changelog (Known limits) a Mac training
//    ran with 10 photos and 100 steps on one Mac with 48 GB; the Standard and
//    Thorough lengths, Macs with less memory and stopping a run have not.
//    The film therefore shows the settings and not a training. No time per
//    step is named. Describe photos is not shown.
//
// Fixtures (nothing on the page is altered):
//  1. tauri platform 'mac', image engine and second image engine (mflux) set
//     up, Z-Image Turbo 4-bit installed (mock option mlx). Not real: nothing
//     is installed. mlx_train_status answers from the mock: engine ready,
//     base z-image-turbo-4bit, adapter not on disk (340 MB), no refusal.
//  2. The photos are the example crops of a paper-cut fox of the Cloud film
//     (videos/character/assets); they are only added to the set, nothing is
//     staged or trained. rustyfox is the example character of the other
//     character films.
test.use({ viewport: { width: 1200, height: 1020 }, deviceScaleFactor: 2 })

test('mac-train', async ({ page }) => {
  test.skip(!HOWTO_OUT, 'set LU_HOWTO_OUT')
  test.setTimeout(120_000)
  const rec = await Rec.boot(page, 'mac-train', 'Train a character on a Mac', {
    mode: 'local',
    tauri: {
      platform: 'mac',
      // Fixture 1.
      mlx: {
        engineInstalled: true, mfluxEngineInstalled: true,
        installedImages: ['sd-turbo', 'z-image-turbo-4bit'],
      },
    },
  })
  await rec.openCreate('Character Studio')
  const train = page.getByRole('radio', { name: 'Train new' })
  if ((await train.getAttribute('aria-checked')) !== 'true') await train.click()
  await expect(page.getByTestId('mac-train-controls')).toBeVisible()
  const drop = page.getByText('Drop 4 to 100 photos of your character here')
  await expect(drop).toBeVisible()
  await page.mouse.move(1000, 520)

  await rec.key(700)
  rec.hold(0.3)
  rec.scene('On a Mac with Z-Image Turbo installed, Train new trains the character on this Mac, from 4 to 100 photos.')
  await rec.cam(drop, 1.3)
  rec.hold(0.8)
  // Fixture 2: the board's own file input, opened by the click on it.
  page.once('filechooser', (fc) => fc.setFiles([1, 2, 3, 4, 5].map((n) => `${HOWTO_OUT}/character/assets/fox-${n}.jpg`)))
  await rec.click(drop, { dur: 0.7, settle: 900, after: 0.2, until: () => expect(page.getByText(/^5\/100 photos$/)).toBeVisible() })
  await rec.cam('full', 1, 0.6)
  rec.hold(1.0)

  rec.scene('Under each photo, name what changes, like clothes or place. It goes into that photo\'s caption.')
  const cap = page.getByRole('textbox', { name: 'What changes in fox-3.jpg' })
  await expect(cap).toBeVisible()
  await rec.cam(cap, 1.6, 0.8)
  await rec.click(cap, { dur: 0.6, at: { fx: 0.2 }, after: 0.1 })
  await rec.type(cap, 'pine forest', { cps: 14, band: { up: 120, down: 60 } })
  rec.hold(1.0)

  rec.scene('The trigger word is the name you call the character by in a prompt.')
  const trigger = page.getByPlaceholder('Trigger word, e.g. davechar')
  await rec.cam(trigger, 1.5, 0.8)
  await rec.click(trigger, { dur: 0.6, at: { fx: 0.25 }, after: 0.1 })
  await rec.move(trigger, { dur: 0.3, at: { fx: 0.5, dy: 30 }, real: false })
  await rec.type(trigger, 'rustyfox', { cps: 12, band: { up: 160, down: 160 } })
  rec.hold(0.3)

  rec.scene('Pick the length. Training is slow on a Mac, and the first run downloads a training adapter.')
  const hint = page.getByTestId('mac-train-hint')
  await expect(hint).toContainText('The first run also downloads a 340 MB training adapter.')
  await rec.click(page.getByRole('radio', { name: 'Quick', exact: true }), { dur: 0.55, settle: 500, after: 0.3 })
  await expect(hint).toContainText('(Quick, 400 steps)')
  await rec.cam(hint, 1.4, 0.8)
  await rec.move(hint, { dur: 0.6, at: { fx: 0.35, dy: 18 }, real: false })
  rec.hold(1.4)

  rec.scene('The character lands in the Mac\'s LoRA folder, where Use character finds it.')
  await rec.move(page.getByTestId('mac-train-open-folder'), { dur: 0.7, at: { dy: 2 } })
  await rec.key(300)
  rec.hold(1.6)
  await rec.cam('full', 1, 0.9)
  rec.finish(1.0)
})
