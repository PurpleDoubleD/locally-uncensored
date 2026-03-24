export interface DiscoverModel {
  name: string
  description: string
  pulls: string
  tags: string[]
  updated: string
}

export async function fetchAbliteratedModels(): Promise<DiscoverModel[]> {
  try {
    const res = await fetch('/ollama-search?q=abliterated&p=1')
    const html = await res.text()

    const models: DiscoverModel[] = []
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    // Parse model cards from search results
    const items = doc.querySelectorAll('[x-test-search-response-title]')
    items.forEach((item) => {
      const container = item.closest('a') || item.parentElement?.closest('a')
      const name = item.textContent?.trim() || ''
      const href = container?.getAttribute('href') || ''

      // Get sibling info
      const parent = item.closest('div')?.parentElement
      const spans = parent?.querySelectorAll('span') || []
      let pulls = ''
      let updated = ''

      spans.forEach((span) => {
        const text = span.textContent?.trim() || ''
        if (text.includes('Pull') || text.includes('K') || text.includes('M')) {
          if (!pulls) pulls = text
        }
        if (text.includes('ago') || text.includes('month') || text.includes('week') || text.includes('day')) {
          updated = text
        }
      })

      if (name && href) {
        models.push({
          name: href.startsWith('/') ? href.slice(1) : name,
          description: '',
          pulls,
          tags: [],
          updated,
        })
      }
    })

    // Fallback: if parsing fails, return curated list
    if (models.length === 0) {
      return getCuratedModels()
    }

    return models
  } catch {
    return getCuratedModels()
  }
}

function getCuratedModels(): DiscoverModel[] {
  return [
    { name: 'mannix/llama3.1-8b-abliterated', description: 'Llama 3.1 8B with safety filters removed', pulls: '200K+', tags: ['8B', 'Q5_K_M'], updated: 'Popular' },
    { name: 'huihui_ai/qwen2.5-abliterated', description: 'Qwen 2.5 abliterated series', pulls: '50K+', tags: ['7B', '14B', '32B'], updated: 'Popular' },
    { name: 'richardyoung/qwen3-14b-abliterated', description: 'Qwen3 14B with 80% reduced refusals', pulls: '4K+', tags: ['14B', 'Q4_K_M'], updated: 'Recent' },
    { name: 'huihui_ai/qwen3-abliterated', description: 'Qwen3 abliterated series', pulls: '30K+', tags: ['8B', '30B'], updated: 'Popular' },
    { name: 'huihui_ai/gemma3-abliterated', description: 'Google Gemma 3 abliterated', pulls: '20K+', tags: ['4B', '12B', '27B'], updated: 'Recent' },
    { name: 'huihui_ai/llama3.3-abliterated', description: 'Llama 3.3 70B abliterated', pulls: '15K+', tags: ['70B'], updated: 'Popular' },
    { name: 'huihui_ai/deepseek-r1-abliterated', description: 'DeepSeek R1 abliterated reasoning', pulls: '40K+', tags: ['8B', '14B', '32B', '70B'], updated: 'Recent' },
    { name: 'huihui_ai/mistral-small-abliterated', description: 'Mistral Small 24B abliterated', pulls: '10K+', tags: ['24B'], updated: 'Recent' },
    { name: 'krith/mistral-nemo-instruct-2407-abliterated', description: 'Mistral Nemo 12B abliterated', pulls: '5K+', tags: ['12B'], updated: 'Popular' },
    { name: 'huihui_ai/phi4-abliterated', description: 'Microsoft Phi-4 abliterated', pulls: '8K+', tags: ['14B'], updated: 'Recent' },
  ]
}
