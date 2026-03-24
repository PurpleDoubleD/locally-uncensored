import { useState } from 'react'
import { Wifi, WifiOff } from 'lucide-react'
import { GlowButton } from '../ui/GlowButton'
import { checkConnection } from '../../api/ollama'

interface Props {
  endpoint: string
  onChange: (endpoint: string) => void
}

export function ApiConfig({ endpoint, onChange }: Props) {
  const [status, setStatus] = useState<'idle' | 'connected' | 'failed'>('idle')
  const [testing, setTesting] = useState(false)

  const handleTest = async () => {
    setTesting(true)
    const ok = await checkConnection()
    setStatus(ok ? 'connected' : 'failed')
    setTesting(false)
  }

  return (
    <div className="space-y-3">
      <label className="text-sm text-gray-300">API Endpoint</label>
      <div className="flex gap-2">
        <input
          value={endpoint}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-sm focus:outline-none focus:border-white/20 font-mono"
        />
        <GlowButton variant="secondary" onClick={handleTest} disabled={testing}>
          {testing ? '...' : 'Test'}
        </GlowButton>
      </div>
      {status === 'connected' && (
        <div className="flex items-center gap-2 text-green-400 text-sm">
          <Wifi size={14} /> Connected
        </div>
      )}
      {status === 'failed' && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <WifiOff size={14} /> Connection failed
        </div>
      )}
    </div>
  )
}
