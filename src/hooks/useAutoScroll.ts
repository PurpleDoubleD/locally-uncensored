import { useEffect, useRef } from 'react'

export function useAutoScroll(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const shouldScroll = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      shouldScroll.current = scrollHeight - scrollTop - clientHeight < 100
    }

    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (shouldScroll.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [dependency])

  return ref
}
