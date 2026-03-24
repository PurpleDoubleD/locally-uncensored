export interface Settings {
  apiEndpoint: string
  temperature: number
  topP: number
  topK: number
  maxTokens: number
  theme: 'light' | 'dark'
  onboardingDone: boolean
}

export interface Persona {
  id: string
  name: string
  icon: string
  systemPrompt: string
  isBuiltIn: boolean
}
