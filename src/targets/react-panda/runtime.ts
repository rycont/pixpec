import { getSvgPath } from 'figma-squircle'
import { useLayoutEffect, useRef, useState } from 'react'

export function useSquircleClip<T extends HTMLElement>(
  cornerRadius: number,
  cornerSmoothing: number,
): [React.RefObject<T | null>, string | undefined] {
  const ref = useRef<T | null>(null)
  const [clipPath, setClipPath] = useState<string | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return
      const path = getSvgPath({
        width: r.width,
        height: r.height,
        cornerRadius,
        cornerSmoothing,
      }).replace(/\n/g, ' ').trim()
      setClipPath(`path('${path}')`)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [cornerRadius, cornerSmoothing])
  return [ref, clipPath]
}
