/**
 * Detect system capabilities (RAM / GPU) to recommend appropriate models.
 * Uses browser APIs: navigator.deviceMemory and WebGL renderer string.
 */

export type SystemTier = 'low' | 'medium' | 'high'

export interface SystemInfo {
    tier: SystemTier
    ramGB: number | null
    gpuRenderer: string | null
    estimatedVRAM: string
}

function detectGPU(): { renderer: string | null; estimatedVRAM: string } {
    try {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') as WebGLRenderingContext | null
        if (!gl) return { renderer: null, estimatedVRAM: 'Unknown' }

        const debugExt = gl.getExtension('WEBGL_debug_renderer_info')
        if (!debugExt) return { renderer: null, estimatedVRAM: 'Unknown' }

        const renderer = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string

        // Rough VRAM estimation from GPU name
        const lower = renderer.toLowerCase()
        let estimatedVRAM = 'Unknown'

        if (lower.includes('4090') || lower.includes('a100') || lower.includes('3090')) {
            estimatedVRAM = '24 GB+'
        } else if (lower.includes('4080') || lower.includes('3080')) {
            estimatedVRAM = '12–16 GB'
        } else if (lower.includes('4070') || lower.includes('3070') || lower.includes('4060 ti')) {
            estimatedVRAM = '8–12 GB'
        } else if (lower.includes('4060') || lower.includes('3060') || lower.includes('2080')) {
            estimatedVRAM = '8 GB'
        } else if (lower.includes('2070') || lower.includes('1080') || lower.includes('rx 6')) {
            estimatedVRAM = '8 GB'
        } else if (lower.includes('1070') || lower.includes('2060') || lower.includes('1660') || lower.includes('rx 580')) {
            estimatedVRAM = '6 GB'
        } else if (lower.includes('1060') || lower.includes('1650') || lower.includes('apple') || lower.includes('m1') || lower.includes('m2') || lower.includes('m3') || lower.includes('m4')) {
            estimatedVRAM = '8 GB (shared)'
        } else if (lower.includes('intel') || lower.includes('uhd') || lower.includes('hd graphics')) {
            estimatedVRAM = '2 GB (integrated)'
        }

        return { renderer, estimatedVRAM }
    } catch {
        return { renderer: null, estimatedVRAM: 'Unknown' }
    }
}

export function detectSystem(): SystemInfo {
    const ramGB = (navigator as any).deviceMemory ?? null
    const gpu = detectGPU()

    let tier: SystemTier = 'medium'

    if (ramGB !== null) {
        if (ramGB <= 4) tier = 'low'
        else if (ramGB >= 16) tier = 'high'
        else tier = 'medium'
    }

    // Refine with GPU info
    const vram = gpu.estimatedVRAM.toLowerCase()
    if (vram.includes('24') || vram.includes('16')) {
        tier = 'high'
    } else if (vram.includes('2 gb') || vram.includes('integrated')) {
        tier = 'low'
    }

    return {
        tier,
        ramGB,
        gpuRenderer: gpu.renderer,
        estimatedVRAM: gpu.estimatedVRAM,
    }
}

export interface ModelRecommendation {
    name: string
    label: string
    description: string
    reason: string
}

export function getRecommendations(tier: SystemTier): ModelRecommendation[] {
    switch (tier) {
        case 'low':
            return [
                {
                    name: 'huihui_ai/qwen2.5-abliterated:7b',
                    label: 'Qwen 2.5 7B',
                    description: 'Lightweight & capable',
                    reason: 'Fits your system well — needs little VRAM',
                },
                {
                    name: 'mannix/llama3.1-8b-abliterated:q5_K_M',
                    label: 'Llama 3.1 8B',
                    description: 'Fast all-rounder',
                    reason: 'Runs well with 6 GB VRAM',
                },
            ]
        case 'medium':
            return [
                {
                    name: 'mannix/llama3.1-8b-abliterated:q5_K_M',
                    label: 'Llama 3.1 8B',
                    description: 'Fast & reliable',
                    reason: 'Perfect for your system — recommended as a starting point',
                },
                {
                    name: 'huihui_ai/qwen3-abliterated:8b',
                    label: 'Qwen3 8B',
                    description: 'Great for coding',
                    reason: 'Latest model, ideal for 8 GB VRAM',
                },
                {
                    name: 'huihui_ai/deepseek-r1-abliterated:8b',
                    label: 'DeepSeek R1 8B',
                    description: 'Reasoning & thinking',
                    reason: 'Chain-of-thought model — shows its thinking process',
                },
            ]
        case 'high':
            return [
                {
                    name: 'richardyoung/qwen3-14b-abliterated:q4_K_M',
                    label: 'Qwen3 14B',
                    description: 'Very smart',
                    reason: 'Your system can handle 14B+ models',
                },
                {
                    name: 'huihui_ai/gemma3-abliterated:12b',
                    label: 'Gemma 3 12B',
                    description: 'Google model with vision',
                    reason: 'Perfect for 12+ GB VRAM',
                },
                {
                    name: 'huihui_ai/mistral-small-abliterated:24b',
                    label: 'Mistral Small 24B',
                    description: 'Very powerful',
                    reason: 'Needs 16 GB+ VRAM — should run on your system',
                },
            ]
    }
}
