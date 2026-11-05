/**
 * The image parts of the chat catalog: the file a local model needs beside its
 * GGUF to take pictures (llama.cpp calls it mmproj).
 *
 * A GGUF chat model carries no image tower. The built-in engine sees images
 * only when this second file lies next to the model and is passed along at
 * start, so a catalog entry of a family with image input names its part here,
 * and the download fetches both files as one job.
 *
 * Every row was read from the file list of its repository on 2026-10-09: the
 * file name as the repository spells it, the exact byte count and the SHA-256
 * the host states for the file. Nothing in this table is derived from a model
 * name.
 *
 * The rows of the models the 2026-10-08 catalog refresh added (Qwen 3.5 4B,
 * Ornith 1.5, Holo4, Ministral 3 and the others of that day) were read the
 * same way on the same day, when the refresh met this table in the merge for
 * 3.0.6. The refresh had named each part by address only.
 *
 * Which file was taken where a repository offers several: F16 first, then
 * BF16, then Q8_0, never F32 (twice the size for no gain a chat can show).
 * Two rows keep the Q8_0 they were tested with (Holo 3.1 and the Qwen 3.8
 * Heretic, whose repository ships no other).
 *
 * Three models take the part of ANOTHER repository, because their own ships
 * none. Each of them is an abliteration, which edits rows of the language
 * model and leaves the image tower alone, and for each the pairing was checked
 * in the two GGUF headers (read by range request, 2026-10-09):
 *
 *   - Qwen 3.5 9B Abliterated (mradermacher/Qwen3.5-9B-abliterated-GGUF): the
 *     header names Qwen/Qwen3.5-9B as its base and an embedding width of 4096.
 *     The part of unsloth/Qwen3.5-9B-GGUF names the same base and projects to
 *     4096.
 *   - Qwen 3.5 35B MoE Abliterated (the i1 repository): its sister repository
 *     mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-GGUF is a conversion of
 *     the same model and ships the part. Embedding width 2048, the part
 *     projects to 2048.
 *   - Gemma 4 31B Unfiltered (TrevorJS): the model card names
 *     google/gemma-4-31B-it as base and abliteration as method. Embedding
 *     width 5376, the part of unsloth/gemma-4-31B-it-GGUF projects to 5376.
 *
 * A model whose repository ships no part and for which no such proof exists
 * stays without image input and says so (`noImagePart` on its entry).
 */

/** The image part of one catalog entry, as the entry carries it. */
export interface ImagePartFields {
  mmprojUrl: string
  /** For the label. GiB with two decimals, like `sizeGB`. */
  mmprojSizeGB: number
  /** Exact, so a file of another size is not this file. */
  mmprojBytes: number
  mmprojSha256: string
}

function part(repo: string, file: string, bytes: number, sha256: string): ImagePartFields {
  return {
    mmprojUrl: `https://huggingface.co/${repo}/resolve/main/${file}`,
    mmprojSizeGB: Math.round((bytes / 1_073_741_824) * 100) / 100,
    mmprojBytes: bytes,
    mmprojSha256: sha256,
  }
}

export const IMAGE_PART = {
  '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/mmproj-Qwen3.8-27B-Q8_0.gguf': part('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Q8_0.gguf', 629247008, '2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb'),
  'DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF/mmproj-F16.gguf': part('DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'mmproj-F16.gguf', 918166080, 'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f'),
  'DavidAU/Qwen3.6-27B-Heretic-Uncensored-FINETUNE-NEO-CODE-Di-IMatrix-MAX-GGUF/mmproj-F16.gguf': part('DavidAU/Qwen3.6-27B-Heretic-Uncensored-FINETUNE-NEO-CODE-Di-IMatrix-MAX-GGUF', 'mmproj-F16.gguf', 927607360, 'eacf610d1ee4bd5ed0197a0777dd8f4fceb8eefa27009067c7d496cb68fbde45'),
  'DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-NEO-CODE-Di-IMatrix-MAX-GGUF/mmproj-F16.gguf': part('DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-NEO-CODE-Di-IMatrix-MAX-GGUF', 'mmproj-F16.gguf', 927607360, 'eacf610d1ee4bd5ed0197a0777dd8f4fceb8eefa27009067c7d496cb68fbde45'),
  'HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf': part('HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive', 'mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf', 990288832, 'debad39ab9c1152ab67695a674fb35e8375b2320c57bfd5075835d3ccb16c7db'),
  'HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced/mmproj-Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf': part('HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced', 'mmproj-Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf', 175115264, 'b59e815479b7e5f0665bd29e6784c104a368092bcbc63120148c606f9276ab8e'),
  'HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf': part('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf', 931146624, '5681b690bcb8eb10cd28d62d078cb4e01521a3ea4880a3fc7d54de72de2dd142'),
  'InternScience/Agents-A1-4B-Q4_K_M-GGUF/Agents-A1-4B-mmproj.gguf': part('InternScience/Agents-A1-4B-Q4_K_M-GGUF', 'Agents-A1-4B-mmproj.gguf', 672423200, '254145e7e03e9e8d3120813fac8033ffa04e411eb6d70a198833504935681084'),
  'InternScience/Agents-A1-Q4_K_M-GGUF/Agents-A1-mmproj.gguf': part('InternScience/Agents-A1-Q4_K_M-GGUF', 'Agents-A1-mmproj.gguf', 899282976, '781c47706c2a2002401358f2acbeeccf545ee4cf9bd7314d4470f4c17f083b1c'),
  'Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF/mmproj.gguf': part('Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF', 'mmproj.gguf', 921705376, 'd589acfddbed3ba291e429330360ded8e67b0910dd415aec2fe7c32b0665f859'),
  'LiconStudio/Gemma-4-31B-it-abliterated-GGUF/mmproj-F16.gguf': part('LiconStudio/Gemma-4-31B-it-abliterated-GGUF', 'mmproj-F16.gguf', 1198956512, '9f9063fbb6c7420c803a4f6c737ffc5dc9330220ff0912e03b121b81a09cb0ed'),
  'Stabhappy/gemma-4-31B-it-heretic-Gguf/mmproj-coder3101_gemma_4_31b_it_heretic-f16.gguf': part('Stabhappy/gemma-4-31B-it-heretic-Gguf', 'mmproj-coder3101_gemma_4_31b_it_heretic-f16.gguf', 1198956864, '862a415082ee8b767f5aa0633cad74818edd9eb5cff91bdfa38a6b8fa1f45440'),
  'Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF/mmproj-Qwen3.6-35B-A3B-Abliterated-Heretic.gguf': part('Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF', 'mmproj-Qwen3.6-35B-A3B-Abliterated-Heretic.gguf', 902822624, '42ef6d5f3564946163628d28ce1380b729ff3634dc37482506bb1eb951138f8c'),
  // LFM3 VL and Omni (N1, 30.10.2026). Q8_0, not F16, on purpose: E1 measured
  // these two parts with the b11960 engine on the Mac (AN-N1-E1.md), and Q8_0
  // halves them. The Omni part carries the audio encoder as well; LU passes
  // it as --mmproj and uses it for images.
  'LiquidAI/LFM3-VL-2B-GGUF/mmproj-LFM3-VL-2B-Q8_0.gguf': part('LiquidAI/LFM3-VL-2B-GGUF', 'mmproj-LFM3-VL-2B-Q8_0.gguf', 203031872, 'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab'),
  // LFM3 Audio's part is an audio encoder only (clip.has_audio_encoder): the
  // LU Engine hears and speaks with it and reports the model as not seeing.
  'LiquidAI/LFM3-Audio-2B-GGUF/mmproj-LFM3-Audio-2B-Q8_0.gguf': part('LiquidAI/LFM3-Audio-2B-GGUF', 'mmproj-LFM3-Audio-2B-Q8_0.gguf', 303811840, '2b6648b1fd48af16aa0877b0592b144d15070783673e038a379fdbc51d40e365'),
  'LiquidAI/LFM3-Omni-2B-GGUF/mmproj-LFM3-Omni-2B-Q8_0.gguf': part('LiquidAI/LFM3-Omni-2B-GGUF', 'mmproj-LFM3-Omni-2B-Q8_0.gguf', 506842528, '8a25f9d1931244429de404fccacfb7fb933970a36aa5688d2f5069f29c6b27b1'),
  'bartowski/FrogNano-4B-2609-GGUF/mmproj-FrogNano-4B-2609-f16.gguf': part('bartowski/FrogNano-4B-2609-GGUF', 'mmproj-FrogNano-4B-2609-f16.gguf', 672423104, 'e6fba76cf8cd2e2e8793807ee54147c1f5a5209bc4780e53e79878e7c9887020'),
  'bartowski/Hcompany_Holo4-35B-A3B-GGUF/mmproj-Hcompany_Holo4-35B-A3B-f16.gguf': part('bartowski/Hcompany_Holo4-35B-A3B-GGUF', 'mmproj-Hcompany_Holo4-35B-A3B-f16.gguf', 899283488, '9fe08693f0ae3c02b3ef76a2762475366c98dcdced879ff90e8258734b5bf6d1'),
  'bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF/mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf': part('bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF', 'mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf', 918166048, 'ff348f3180a63188aa7285db85f550fe38acb61dd013c599eb8bad08d2cc2576'),
  'bartowski/TheDrummer_Artemis-31B-v1.2-GGUF/mmproj-TheDrummer_Artemis-31B-v1.2-f16.gguf': part('bartowski/TheDrummer_Artemis-31B-v1.2-GGUF', 'mmproj-TheDrummer_Artemis-31B-v1.2-f16.gguf', 1198956832, '83e25a30c1d377fcb40cedd0c3dc0a3a6dba48ca3d09b2136ea2d86727b14792'),
  'bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF/mmproj-TheDrummer_Orion-26B-A4B-v1.1-f16.gguf': part('bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF', 'mmproj-TheDrummer_Orion-26B-A4B-v1.1-f16.gguf', 1193058368, 'bbf83f3a6e1edd3ce8affa2d39981df05591aa222d380f1b52f2be0e8726c9c9'),
  'bartowski/mlabonne_gemma-3-12b-it-abliterated-GGUF/mmproj-mlabonne_gemma-3-12b-it-abliterated-f16.gguf': part('bartowski/mlabonne_gemma-3-12b-it-abliterated-GGUF', 'mmproj-mlabonne_gemma-3-12b-it-abliterated-f16.gguf', 854200224, '30c02d056410848227001830866e0a269fcc28aaf8ca971bded494003de9f5a5'),
  'bartowski/mlabonne_gemma-3-27b-it-abliterated-GGUF/mmproj-mlabonne_gemma-3-27b-it-abliterated-f16.gguf': part('bartowski/mlabonne_gemma-3-27b-it-abliterated-GGUF', 'mmproj-mlabonne_gemma-3-27b-it-abliterated-f16.gguf', 857739168, '54cb61c842fe49ac3c89bc1a614a2778163eb49f3dec2b90ff688b4c0392cb48'),
  'bartowski/mlabonne_gemma-3-4b-it-abliterated-GGUF/mmproj-mlabonne_gemma-3-4b-it-abliterated-f16.gguf': part('bartowski/mlabonne_gemma-3-4b-it-abliterated-GGUF', 'mmproj-mlabonne_gemma-3-4b-it-abliterated-f16.gguf', 851251104, '8c0fb064b019a6972856aaae2c7e4792858af3ca4561be2dbf649123ba6c40cb'),
  'bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf': part('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf', 927607584, 'bf709317815597d2ee48b8fb10796c9a22006da2f329d76e37761433a66fa697'),
  'culturerevolt/gemma-4-12b-heretic-abliterated-GGUF/gemma-4-12b-heretic-mmproj-f16.gguf': part('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-mmproj-f16.gguf', 175115840, '2e269f906eb15169ee9ce880ea649bd6d42d4964c21f8ede10d0d0efc738bcbb'),
  'empero-ai/Qwen3.8-35B-A3B-Distill-GGUF/mmproj-Qwen3.8-35B-A3B-F16.gguf': part('empero-ai/Qwen3.8-35B-A3B-Distill-GGUF', 'mmproj-Qwen3.8-35B-A3B-F16.gguf', 899283520, '4381cb5110074396c2c7b39221fffae0c31886aa95b674de8e103d97edf58b94'),
  'google/gemma-4-12B-it-qat-q4_0-gguf/mmproj-gemma-4-12b-it-qat-q4_0.gguf': part('google/gemma-4-12B-it-qat-q4_0-gguf', 'mmproj-gemma-4-12b-it-qat-q4_0.gguf', 175115616, 'cb018338a7538a9814d994bfe54644c71eb7ed54e31eae2f721e45fd3c260da7'),
  'huihui-ai/Huihui-Agents-A1-abliterated-GGUF/mmproj-model-bf16.gguf': part('huihui-ai/Huihui-Agents-A1-abliterated-GGUF', 'mmproj-model-bf16.gguf', 902821824, 'cb9d31393d9b4c1cf0a96f3aad158518c0098e0748d43df9ddecf25b7859af67'),
  'huihui-ai/Huihui-Qwen3.6-27B-abliterated-MTP-GGUF/mmproj-model-f16.gguf': part('huihui-ai/Huihui-Qwen3.6-27B-abliterated-MTP-GGUF', 'mmproj-model-f16.gguf', 927607136, 'dca6010f6b2c28cf901807623385966828a74694958708d8b12e2913e2722277'),
  'huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-MTP-GGUF/mmproj-model-f16.gguf': part('huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-MTP-GGUF', 'mmproj-model-f16.gguf', 899283072, '1d65ff96185b02195740d488b85c3b3e8dadfe950ce175ec0f7bfc744aae9f37'),
  'huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/mmproj-model-bf16.gguf': part('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'mmproj-model-bf16.gguf', 931145888, 'c9a09064683620bea3d3bfed5d4462e1a97a7d2fff7e5045d6862a0a85eeb5b5'),
  'huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF/mmproj-model-bf16.gguf': part('huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF', 'mmproj-model-bf16.gguf', 921705184, '58a875ef97592d9a559b05a2b10612571064144c20a238c31af6188a443e2762'),
  'huihui-ai/Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF/mmproj-model-bf16.gguf': part('huihui-ai/Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF', 'mmproj-model-bf16.gguf', 175115776, 'bd94de2c9e403f851cc3841ffd45c478c3530072dfb006476534d18825e0bc84'),
  'huihui-ai/Huihui-gemma-4-31B-it-qat-q4_0-unquantized-abliterated-GGUF/mmproj-model-bf16.gguf': part('huihui-ai/Huihui-gemma-4-31B-it-qat-q4_0-unquantized-abliterated-GGUF', 'mmproj-model-bf16.gguf', 1200726112, 'fa3c584233a103b5fac2e0533b4054a6bc74ec91d836b804663d8e6f5e624afa'),
  'huihui-ai/Huihui-gemma-4-E2B-it-qat-q4_0-unquantized-abliterated-GGUF/mmproj-model-bf16.gguf': part('huihui-ai/Huihui-gemma-4-E2B-it-qat-q4_0-unquantized-abliterated-GGUF', 'mmproj-model-bf16.gguf', 986833408, 'd77ea8edb2f703d0bfd2a805d8471b1c99b11340c9ae7749fed4b5f2c9de0c48'),
  'llmfan46/Ornith-1.0-35B-uncensored-heretic-GGUF/Ornith-1.0-35B-uncensored-heretic-mmproj-BF16.gguf': part('llmfan46/Ornith-1.0-35B-uncensored-heretic-GGUF', 'Ornith-1.0-35B-uncensored-heretic-mmproj-BF16.gguf', 902822048, '27b316521af1b6338a679e17ed26c3960c843cf0e1510ae45a247352b8513d41'),
  'lmstudio-community/gemma-4-12b-it-GGUF/mmproj-gemma-4-12B-it-BF16.gguf': part('lmstudio-community/gemma-4-12b-it-GGUF', 'mmproj-gemma-4-12B-it-BF16.gguf', 175115296, '7fd884a5f7d9ee60f6b88e5b51287151e547454b2b60a4a6270bb5434310ad0e'),
  'mistralai/Ministral-3-14B-Instruct-2512-GGUF/Ministral-3-14B-Instruct-2512-BF16-mmproj.gguf': part('mistralai/Ministral-3-14B-Instruct-2512-GGUF', 'Ministral-3-14B-Instruct-2512-BF16-mmproj.gguf', 879258784, 'ab7616148b7081030fd38e410c9213ce8346a8b0588291c8ca279058e78cfae7'),
  'mistralai/Ministral-3-3B-Instruct-2512-GGUF/Ministral-3-3B-Instruct-2512-BF16-mmproj.gguf': part('mistralai/Ministral-3-3B-Instruct-2512-GGUF', 'Ministral-3-3B-Instruct-2512-BF16-mmproj.gguf', 841501856, '70ca26e41ecea9da997e2887462ad68b848fbf64da011ff4107bbe7353519ee0'),
  'mistralai/Ministral-3-8B-Instruct-2512-GGUF/Ministral-3-8B-Instruct-2512-BF16-mmproj.gguf': part('mistralai/Ministral-3-8B-Instruct-2512-GGUF', 'Ministral-3-8B-Instruct-2512-BF16-mmproj.gguf', 858283168, 'e799380f596d152ff4026a72d409ecc89c96cd437676804bc3f2ab3bd6b486ec'),
  'mradermacher/Holo-3.1-9B-GGUF/Holo-3.1-9B.mmproj-Q8_0.gguf': part('mradermacher/Holo-3.1-9B-GGUF', 'Holo-3.1-9B.mmproj-Q8_0.gguf', 624230368, 'f73c004cb5936351867593855eda826ece87f0bcc81539ee7f9a5e2beacaf5ad'),
  'mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF/Huihui-Ornith-1.5-35B-A3B-abliterated.mmproj-f16.gguf': part('mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF', 'Huihui-Ornith-1.5-35B-A3B-abliterated.mmproj-f16.gguf', 899283648, '1cfdea64d9fded1ca8ff0e08125cdc506ee87cfa2daa6be92e913c9ae08733f0'),
  'mradermacher/Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated-GGUF/Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.mmproj-f16.gguf': part('mradermacher/Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated-GGUF', 'Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.mmproj-f16.gguf', 927607616, 'abb22e983d5cf2951643c125c300f139a3c30a2293dbe443985d4a450281507c'),
  'mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-GGUF/Huihui-Qwen3.5-35B-A3B-abliterated.mmproj-f16.gguf': part('mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-GGUF', 'Huihui-Qwen3.5-35B-A3B-abliterated.mmproj-f16.gguf', 899283616, '5d16c59baba77510779993dba610cc771280dfd7301f1d348ecdf50cb6171326'),
  'mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/Huihui-Qwen3.5-4B-abliterated.mmproj-f16.gguf': part('mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF', 'Huihui-Qwen3.5-4B-abliterated.mmproj-f16.gguf', 672423552, 'f14643c11f1e8244c59bca670e2a4c843be4234aa6bb88d0647dae7297798686'),
  'mradermacher/Ornith-1.5-9B-uncensored-GGUF/Ornith-1.5-9B-uncensored.mmproj-f16.gguf': part('mradermacher/Ornith-1.5-9B-uncensored-GGUF', 'Ornith-1.5-9B-uncensored.mmproj-f16.gguf', 918166016, '3170dd53d7ed442c944cfb378535e96a5981283d65ec4f6c389f07999f32b380'),
  'mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF/Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf': part('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf', 1159030336, 'fe1a01686420659ecfc442347ea8d07ab43e2eaafc9c9e709910a73d992b99b2'),
  'nohurry/gemma-4-26B-A4B-it-heretic-GUFF/gemma-4-26B-A4B-it-heretic-mmproj.f16.gguf': part('nohurry/gemma-4-26B-A4B-it-heretic-GUFF', 'gemma-4-26B-A4B-it-heretic-mmproj.f16.gguf', 1193058880, 'c75be1dbc6939bfefa53a4e449fbf843869b5b3470680fa631fd32856ae4240e'),
  'ornith-ai/Ornith-1.5-35B-A3B-GGUF/mmproj-Ornith-1.5-35B-BF16.gguf': part('ornith-ai/Ornith-1.5-35B-A3B-GGUF', 'mmproj-Ornith-1.5-35B-BF16.gguf', 902822240, '1921a36a85aee56cd2abd27f46701802c9d85a33474792e600df6c3b282a135d'),
  'ornith-ai/Ornith-1.5-9B-GGUF/mmproj-Ornith-1.5-9B-BF16.gguf': part('ornith-ai/Ornith-1.5-9B-GGUF', 'mmproj-Ornith-1.5-9B-BF16.gguf', 921704672, '626f9f90627402a6bf4a999111d0fbd69b5fcca7aa8ba089d69e5f10e8858e1d'),
  'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF/mmproj-F16.gguf': part('unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF', 'mmproj-F16.gguf', 878054048, '236bb4f0500620164917f26749cd402485b7d749034ea817c6a2d65253b126b9'),
  'unsloth/Kimi-K2.7-Code-GGUF/mmproj-F16.gguf': part('unsloth/Kimi-K2.7-Code-GGUF', 'mmproj-F16.gguf', 952572320, '9036f4050ca6e0cb4007ad9e46644f47031b4b979ba29ae4e355de5e006e7afe'),
  'unsloth/Kimi-K3-GGUF/mmproj-F16.gguf': part('unsloth/Kimi-K3-GGUF', 'mmproj-F16.gguf', 903244832, '1937732929a5279d442a98345e93772e759bc7cbae8b2bb8b80a1648574d53a3'),
  'unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF/mmproj-F16.gguf': part('unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF', 'mmproj-F16.gguf', 1746780928, '70240ddf9daa0a91570a0975c0480044cb6b84bea427feb52bc0226df682fdeb'),
  'unsloth/Mistral-Medium-3.5-128B-GGUF/mmproj-F16.gguf': part('unsloth/Mistral-Medium-3.5-128B-GGUF', 'mmproj-F16.gguf', 5356846528, '494e993f80330f170ca6dd436db7a8f64cbc5617fcccf3e7d12564667114b272'),
  'unsloth/Mistral-Small-4-119B-2603-GGUF/mmproj-F16.gguf': part('unsloth/Mistral-Small-4-119B-2603-GGUF', 'mmproj-F16.gguf', 857078496, '8afb53096537664e248a0b4a9240c25677bb0f8a8cb5a5aad3cd1d608776a4e7'),
  'unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF/mmproj-F16.gguf': part('unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF', 'mmproj-F16.gguf', 1587540224, '8e72b13d61ac5972793b94e130e69d93ebbc96bc8e281500c03e762282b1840f'),
  'unsloth/Qwen3.5-27B-GGUF/mmproj-F16.gguf': part('unsloth/Qwen3.5-27B-GGUF', 'mmproj-F16.gguf', 927607040, '458bc46d8f275866fde5d88c9c554d9d462a6e8e3a028090d9850e17ab6a1217'),
  'unsloth/Qwen3.5-35B-A3B-GGUF/mmproj-F16.gguf': part('unsloth/Qwen3.5-35B-A3B-GGUF', 'mmproj-F16.gguf', 899283648, 'a516ab92e8240da4734d68352bdfba84c16e830ee40010b8fac80d69c77272ff'),
  'unsloth/Qwen3.5-4B-GGUF/mmproj-F16.gguf': part('unsloth/Qwen3.5-4B-GGUF', 'mmproj-F16.gguf', 672423616, 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864'),
  'unsloth/Qwen3.5-9B-GGUF/mmproj-F16.gguf': part('unsloth/Qwen3.5-9B-GGUF', 'mmproj-F16.gguf', 918166080, 'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f'),
  'unsloth/Qwen3.6-27B-GGUF/mmproj-F16.gguf': part('unsloth/Qwen3.6-27B-GGUF', 'mmproj-F16.gguf', 927607360, 'eacf610d1ee4bd5ed0197a0777dd8f4fceb8eefa27009067c7d496cb68fbde45'),
  'unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf': part('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf', 927607488, 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e'),
  'unsloth/gemma-3-12b-it-GGUF/mmproj-F16.gguf': part('unsloth/gemma-3-12b-it-GGUF', 'mmproj-F16.gguf', 854200448, '5de4ccfc379faa4cbf608dd365c028aa41f9774cdb1191d148d88910d1014f71'),
  'unsloth/gemma-3-27b-it-GGUF/mmproj-F16.gguf': part('unsloth/gemma-3-27b-it-GGUF', 'mmproj-F16.gguf', 857739392, 'debe2545831a2566dcec81992b9aa8fa8381c5a0a3588c0b59a41cc9c610cfe7'),
  'unsloth/gemma-4-26B-A4B-it-GGUF/mmproj-F16.gguf': part('unsloth/gemma-4-26B-A4B-it-GGUF', 'mmproj-F16.gguf', 1193058784, '418a6d8723067cd712235facbbc5cba6c8fbbd413fc1292d2aace5a027d5a42f'),
  'unsloth/gemma-4-31B-it-GGUF/mmproj-F16.gguf': part('unsloth/gemma-4-31B-it-GGUF', 'mmproj-F16.gguf', 1198957024, '6edcca228213c28d3567a35d22f849eea52d8360875093851959adf5d2f270eb'),
  'unsloth/gemma-4-E2B-it-GGUF/mmproj-F16.gguf': part('unsloth/gemma-4-E2B-it-GGUF', 'mmproj-F16.gguf', 985654080, '140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa'),
  'unsloth/gemma-4-E4B-it-GGUF/mmproj-F16.gguf': part('unsloth/gemma-4-E4B-it-GGUF', 'mmproj-F16.gguf', 990372672, 'ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51'),
} as const satisfies Record<string, ImagePartFields>
