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
        if (!el) {
            return
        }
        let frame = 0
        const timeouts: ReturnType<typeof setTimeout>[] = []
        const update = () => {
            const r = el.getBoundingClientRect()
            if (!r.width || !r.height) {
                return
            }
            const rootFontSize = Number.parseFloat(
                window.getComputedStyle(document.documentElement).fontSize,
            )
            const scale = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize / 16 : 1
            const path = getSvgPath({
                width: r.width,
                height: r.height,
                cornerRadius: cornerRadius * scale * 1.02,
                cornerSmoothing,
            })
                .replace(/\n/g, ' ')
                .trim()
            setClipPath(`path('${path}')`)
        }
        let framesLeft = 12
        const scheduleFrames = () => {
            if (framesLeft <= 0) {
                return
            }
            frame = requestAnimationFrame(() => {
                framesLeft -= 1
                update()
                scheduleFrames()
            })
        }
        update()
        scheduleFrames()
        for (const ms of [50, 200, 800]) {
            timeouts.push(setTimeout(update, ms))
        }
        const ro = new ResizeObserver(update)
        ro.observe(el)
        return () => {
            cancelAnimationFrame(frame)
            for (const timeout of timeouts) {
                clearTimeout(timeout)
            }
            ro.disconnect()
        }
    }, [cornerRadius, cornerSmoothing])
    return [ref, clipPath]
}
