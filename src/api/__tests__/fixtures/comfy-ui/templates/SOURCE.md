# Real ComfyUI workflow templates

Copied unchanged from the PyPI package `comfyui-workflow-templates-json`
0.1.111 (`comfyui_workflow_templates_json/templates/`), the template files
ComfyUI ships. The templates come from github.com/Comfy-Org/workflow_templates.

License: MIT, as declared by the package (`License-Expression: MIT`).
Copyright Comfy Org and the contributors of that repository.

| File | SHA-256 | Used for |
|---|---|---|
| image_z_image_turbo.json | baaf937ff071970cc6b1e2fa0093a4dd664a4cc734d38adc4c7810e535c1f1d3 | one subgraph; same file as in the ComfyUI 0.40.0 install of the 3.0.8 Windows test run |
| image_netayume_lumina_t2i.json | 988b37618599a5bdbbef776f438d64c5f3c5e205800d337cc1280e5e817ca2eb | a subgraph nested in a subgraph |
| video_ltx2_5_i2v.json | 03b136ba0ad752c1e91e496a23fa4f4826ef881777d591dc9129c459922e7dac | GitHub #196: V3 inputs, two VAEs and CLIPs, no KSampler, ResolutionSelector |

`video_ltx2_5_i2v.json` comes straight from the repository instead:
github.com/Comfy-Org/workflow_templates, path `templates/video_ltx2_5_i2v.json`
at commit 14220b8bd3e86baa852959f17039613191e66656 (main on 2026-10-28; the
file last changed in e7cd011d4ded3411c2f481200544f0be6fdc962e, git blob
15a7d911874f48957dd0fe0d5e3dd15047fc73a9). Same MIT license (LICENSE of that
repository). Unchanged.

## ../object-info-ltx25.json

What `/object_info` serves for the 32 node types of `video_ltx2_5_i2v.json`,
written down by hand from the ComfyUI sources at tag v0.42.4 (commit
3f438ca69f3d0efc5f748de055daeea9ba26ee50). Tooltips are left out, the sampler
list is cut short, and the loader lists hold the files the template names, as
on a machine that has them. How the V3 types serialize:
`comfy_api/latest/_io.py` (DynamicCombo 1230, Autogrow 1093, MultiType 969
with `widgetType`, MatchType 1018, ResolutionPreview 1584,
create_input_dict_v1 2073, get_v1_info 1966).

| Node | Source (v0.42.4) |
|---|---|
| TextGenerateLTX2Prompt | comfy_extras/nodes_textgen.py 4 (inputs of TextGenerate), 233 |
| ComfyMathExpression | comfy_extras/nodes_math.py 70 |
| ResolutionSelector | comfy_extras/nodes_resolution.py 36 (options 7) |
| ComfySwitchNode | comfy_extras/nodes_logic.py 91 |
| PrimitiveStringMultiline, PrimitiveInt, PrimitiveBoolean | comfy_extras/nodes_primitive.py 28, 46, 82 |
| PreviewAny | comfy_extras/nodes_preview_any.py 8 |
| ManualSigmas, RandomNoise, KSamplerSelect, SamplerCustomAdvanced | comfy_extras/nodes_custom_sampler.py 1129, 1007, 383, 1024 |
| ResizeImageMaskNode | comfy_extras/nodes_post_processing.py 443 (ResizeType 261) |
| LTXVConditioning, LTXVDualCFGGuider, LTXVImgToVideoInplace, LTXVPreprocess, EmptyLTXVLatentVideo, LTXVConcatAVLatent, LTXVSeparateAVLatent | comfy_extras/nodes_lt.py 697, 1251, 137, 872, 67, 901, 976 |
| LTXVEmptyLatentAudio, LTXVAudioVAEDecode | comfy_extras/nodes_lt_audio.py 97, 64 |
| LTXVLatentUpsampler | comfy_extras/nodes_lt_upsampler.py 15 |
| LatentUpscaleModelLoader | comfy_extras/nodes_hunyuan.py 184 |
| CreateVideo, SaveVideo | comfy_extras/nodes_video.py 210, 139 (codec input 76) |
| CLIPTextEncode, VAEDecodeTiled, VAELoader, UNETLoader, CLIPLoader, LoadImage | nodes.py 58, 348, 776, 992, 1017, 1747 |


Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
