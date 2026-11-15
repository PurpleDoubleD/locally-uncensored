/**
 * A27 (3.1.0, GitHub #234): a main model folder picked from a title (the
 * CivitAI search, a chat link), not from a catalog. Such a download asks the
 * backend to read the finished file's header and move it to the folder the
 * header names: checkpoints, diffusion_models, vae or text_encoders
 * (src-tauri/src/commands/model_sniff.rs, `settle_by_header`).
 *
 * A module of its own so a panel can ask without importing api/discover.
 */
export function folderIsAGuess(subfolder: string): boolean {
  return subfolder === 'checkpoints' || subfolder === 'diffusion_models' || subfolder === 'unet'
}
