// ─── Component Registry: What each model type needs to work ───
//
// K9 (GH #136, Krea 2 classification): this table used to be typed
// out TWICE, once in comfyui.ts (matchPatterns/downloadFilename/clipType,
// read by findMatchingVAE/findMatchingCLIP and the workflow builders) and
// once in discover.ts (patterns/downloadName/downloadUrl/subfolder, read by
// the component-completion download path and the catalogAddresses live-URL
// gate). Adding a new model type meant remembering to update both, and
// Krea 2 only reached one of them, which is exactly the kind of gap that let
// #136 happen in the first place. Same shape as the Audit W-T2 fix that
// pulled the bundle catalog out of comfyui.ts/discover.ts into
// model-bundles.ts: shared data lives in its own file that both import, so
// there is exactly one place to update and neither module has to reach into
// the other (comfyui.ts and discover.ts staying acyclic is deliberate, see
// the Audit W-T2 comment at the top of comfyui.ts).

/** One component (VAE or text encoder) a model type needs. */
export interface ComponentSpec {
  /** Substrings tried in order against the live ComfyUI enum. */
  matchPatterns: string[]
  /** Filename to write to disk when this component is fetched. */
  downloadFilename: string
  /** Direct download address, when one is known and verified reachable
   *  (checked by `hf-catalog-addresses.live.test.ts`). Absent means "the app
   *  cannot offer a one-click download for this component": findMatchingVAE
   *  / findMatchingCLIP still tell the user which file to get and where the
   *  Model Manager looks for it, they just cannot fetch it automatically. */
  downloadUrl?: string
  /** ComfyUI\models subfolder this component's download lands in. */
  subfolder?: string
  /** Size, for the "download N GB now?" question in Create. */
  sizeGB?: number
  /** The file's sha256 where the component is not in the bundle catalogue
   *  (B45: the Krea 2 style reference LoRA). The download is checked
   *  against it; a catalogue file takes its digest from the catalogue. */
  sha256?: string
}

export interface ComponentRequirements {
  // SVD loads through ComfyUI's ImageOnlyCheckpointLoader.
  loader: 'UNETLoader' | 'CheckpointLoaderSimple' | 'ImageOnlyCheckpointLoader'
  needsSeparateVAE: boolean
  needsSeparateCLIP: boolean
  vae?: ComponentSpec
  clip?: ComponentSpec
  /** A second required text encoder (FLUX v1's clip_l alongside its T5). */
  clipSecondary?: ComponentSpec
  /** A separate sound autoencoder (MiniMax H3 decodes its audio with it). */
  audioVae?: ComponentSpec
  /** A latent upscaler the graph runs between its two passes (LTX 2.5). */
  upscaler?: ComponentSpec
  /** The CLIPLoader `type` widget value for this architecture, when the
   *  loader is CLIPLoader (single encoder). */
  clipType?: string
}

export const COMPONENT_REGISTRY: Record<string, ComponentRequirements> = {
  sd15: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  sdxl: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  flux: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'flux',
    vae: { matchPatterns: ['ae', 'flux'], downloadFilename: 'ae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['t5xxl', 't5-xxl', 't5_xxl'], downloadFilename: 't5xxl_fp8_e4m3fn.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders' },
    clipSecondary: { matchPatterns: ['clip_l'], downloadFilename: 'clip_l.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors', subfolder: 'text_encoders' },
  },
  flux2: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'flux2',
    vae: { matchPatterns: ['flux2', 'flux'], downloadFilename: 'flux2-vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['qwen', 'mistral'], downloadFilename: 'qwen_3_4b_fp4_flux2.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors', subfolder: 'text_encoders' },
  },
  // Krea 2 (K9, GH #136): companion VAE/CLIP filenames are not standardized
  // across CivitAI finetune authors (qwen_image_vae vs wan_2.1_vae;
  // qwen3vl_4b_int8_convrot vs qwen3vl_4b_fp8_scaled, see the issue).
  // Nachbessert Runde 3: downloadUrl now points at the official
  // Comfy-Org/Krea-2 repackage (verified reachable via HEAD, 2026-09-18),
  // the exact filenames findMatchingVAE/findMatchingCLIP already name in
  // their error text; see the matching Model Manager bundle in
  // model-bundles.ts ("Krea 2 Companion Files").
  krea2: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'krea2',
    vae: { matchPatterns: ['krea', 'qwen_image', 'wan'], downloadFilename: 'qwen_image_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['qwen3vl', 'qwen3_vl'], downloadFilename: 'qwen3vl_4b_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors', subfolder: 'text_encoders' },
  },
  zimage: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'qwen_image',
    vae: { matchPatterns: ['ae', 'flux'], downloadFilename: 'ae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['qwen_3_4b', 'qwen3'], downloadFilename: 'qwen_3_4b.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors', subfolder: 'text_encoders' },
  },
  // Qwen-Image 2.1 (Comfy-Org/Qwen-Image-2.1, verified reachable via HEAD
  // 2026-09-21). Same three-file shape as Z-Image, with its own autoencoder
  // and the Qwen3-VL 8B encoder. The match patterns carry the version tag and
  // the 8B tier because Krea 2's companions (qwen_image_vae, qwen3vl_4b_*)
  // live in the same two folders and would otherwise answer first.
  qwenimage: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'qwen_image',
    vae: { matchPatterns: ['qwen_image_2.1_vae', 'qwen_image_2.1'], downloadFilename: 'qwen_image_2.1_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['qwen3vl_8b'], downloadFilename: 'qwen3vl_8b_int8_convrot.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors', subfolder: 'text_encoders' },
  },
  ernie_image: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'flux2',
    vae: { matchPatterns: ['flux2-vae', 'flux2', 'flux'], downloadFilename: 'flux2-vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['ministral-3-3b', 'ministral', 'ernie-image-prompt-enhancer'], downloadFilename: 'ministral-3-3b.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors', subfolder: 'text_encoders' },
  },
  wan: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'wan',
    vae: { matchPatterns: ['wan', 'hunyuan'], downloadFilename: 'wan_2.1_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['umt5', 'wan'], downloadFilename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
  },
  wan22: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'wan',
    // Wan 2.2 5B uses its OWN VAE (higher compression than 2.1). Prefer the 2.2 file;
    // 'wan' fallback covers a 2.1 VAE only as a last resort. CLIP is the shared UMT5.
    vae: { matchPatterns: ['wan2.2', 'wan2_2'], downloadFilename: 'wan2.2_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['umt5', 'wan'], downloadFilename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
  },
  hunyuan: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'wan',
    vae: { matchPatterns: ['hunyuanvideo', 'hunyuan', 'wan'], downloadFilename: 'hunyuanvideo15_vae_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['qwen', 'llava', 'umt5'], downloadFilename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', subfolder: 'text_encoders' },
  },
  ltx: {
    loader: 'UNETLoader', needsSeparateVAE: false, needsSeparateCLIP: true, clipType: 'ltxv',
    clip: { matchPatterns: ['gemma'], downloadFilename: 'gemma_3_12B_it_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors', subfolder: 'text_encoders' },
  },
  // LTX 2.5 (ComfyUI 0.32.0). The official repo Lightricks/LTX-2.5 is gated (a
  // download needs a Hugging Face token), so the companions come from free
  // mirrors with the same byte counts and SHA-256 (see the bundle in
  // model-bundles.ts). The 2.3 entry above keeps Gemma 3; these are the 2.5
  // files of the official template video_ltx2_5_t2v. Sizes are GiB.
  ltx25: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'ltxv',
    vae: { matchPatterns: ['ltx-2.5-video-vae'], downloadFilename: 'ltx-2.5-video-vae-bf16.safetensors', downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors', subfolder: 'vae', sizeGB: 1.37 },
    clip: { matchPatterns: ['gemma4', 'ltx-2.5'], downloadFilename: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', downloadUrl: 'https://huggingface.co/deAPI-ai/ltx2-5-22b-dist-int8/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', subfolder: 'text_encoders', sizeGB: 14.32 },
    audioVae: { matchPatterns: ['ltx-2.5-audio-vae'], downloadFilename: 'ltx-2.5-audio-vae-bf16.safetensors', downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors', subfolder: 'vae', sizeGB: 0.34 },
    upscaler: { matchPatterns: ['ltx-2.5-latent-spatial-upscaler'], downloadFilename: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', downloadUrl: 'https://huggingface.co/comfyicu/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', subfolder: 'latent_upscale_models', sizeGB: 0.93 },
  },
  // MiniMax H3 (Discord, throwaway 2026-09-26): one model for picture and sound. The
  // video VAE comes from here, the audio VAE is a second file the builder
  // finds through findMiniMaxAudioVAE.
  minimaxh3: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'minimax',
    vae: { matchPatterns: ['minimax_h3_video_vae', 'minimax'], downloadFilename: 'minimax_h3_video_vae_int8_convrot.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors', subfolder: 'vae', sizeGB: 2.8 },
    clip: { matchPatterns: ['minimax_h3_nvfp4', 'minimax'], downloadFilename: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', subfolder: 'text_encoders', sizeGB: 15.7 },
    audioVae: { matchPatterns: ['minimax_h3_audio_vae'], downloadFilename: 'minimax_h3_audio_vae_fp32.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors', subfolder: 'vae', sizeGB: 0.6 },
  },
  // YuE2 (Comfy-Org/YuE2, ComfyUI 0.36.0): model, text model and audio VAE in
  // one checkpoint, like ACE Step, so there is nothing separate to fetch.
  yue2: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  mochi: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'mochi',
    vae: { matchPatterns: ['mochi'], downloadFilename: 'mochi_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/vae/mochi_vae.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['t5'], downloadFilename: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
  },
  cosmos: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'cosmos',
    vae: { matchPatterns: ['cosmos'], downloadFilename: 'cosmos_cv8x8x8_1.0.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/vae/cosmos_cv8x8x8_1.0.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['oldt5'], downloadFilename: 'oldt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/text_encoders/oldt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
  },
  cogvideo: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'cogvideo',
    vae: { matchPatterns: ['cogvideox', 'cogvideo'], downloadFilename: 'cogvideox_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/CogVideoX-comfy/resolve/main/cogvideox_vae_bf16.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['t5'], downloadFilename: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
  },
  svd: {
    loader: 'ImageOnlyCheckpointLoader', needsSeparateVAE: false, needsSeparateCLIP: false,
  },
  framepack: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'wan',
    vae: { matchPatterns: ['hunyuan_video_vae', 'hunyuan'], downloadFilename: 'hunyuan_video_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/vae/hunyuan_video_vae_bf16.safetensors', subfolder: 'vae' },
    clip: { matchPatterns: ['llava', 'qwen', 'umt5'], downloadFilename: 'llava_llama3_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/llava_llama3_fp8_scaled.safetensors', subfolder: 'text_encoders' },
  },
  pyramidflow: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: false, clipType: 'pyramidflow',
    vae: { matchPatterns: ['pyramid'], downloadFilename: 'pyramid_flow_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/pyramid-flow-comfy/resolve/main/pyramid_flow_vae_bf16.safetensors', subfolder: 'vae' },
  },
  allegro: {
    loader: 'UNETLoader', needsSeparateVAE: false, needsSeparateCLIP: false, clipType: 'allegro',
  },
  unknown: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
}
