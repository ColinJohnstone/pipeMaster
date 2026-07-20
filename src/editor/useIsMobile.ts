import { useEffect, useState } from 'react'

/**
 * True on phones and small/touch tablets. Uses a viewport-width media query
 * (robust across devices and narrow desktop windows) combined with a
 * coarse-pointer check, and stays live across resizes and orientation changes.
 */
const QUERY = '(max-width: 820px), (pointer: coarse) and (max-width: 1024px)'

/** `?mobile=1` forces the mobile view, `?mobile=0` forces desktop (for QA). */
function override(): boolean | null {
  if (typeof window === 'undefined') return null
  const p = new URLSearchParams(window.location.search).get('mobile')
  if (p === '1') return true
  if (p === '0') return false
  return null
}

export function useIsMobile(): boolean {
  const forced = override()
  const [isMobile, setIsMobile] = useState(
    () => forced ?? (typeof window !== 'undefined' && window.matchMedia(QUERY).matches),
  )
  useEffect(() => {
    if (forced !== null) {
      setIsMobile(forced)
      return
    }
    const mq = window.matchMedia(QUERY)
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [forced])
  return isMobile
}
