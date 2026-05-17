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

export function mergeProps<T extends object>(defaults: T, props: Partial<T>): T {
    const out = { ...defaults }
    for (const k in props) {
        const raw = props[k as keyof T]
        if (raw === undefined) continue
        const v = normalizeLiteralProp(raw) as T[keyof T]
        out[k as keyof T] = v
    }
    return out
}

/** Pixpec usecases serialize literal length/color values as `{kind:'literal',
 *  value:{value,unit}}` or `{kind:'literal', value:{r,g,b,a?}}`. Components
 *  expect primitive strings, so we flatten on the merge boundary. */
function normalizeLiteralProp(v: unknown): unknown {
    if (!v || typeof v !== 'object') return v
    const obj = v as Record<string, unknown>
    if (obj.kind !== 'literal') return v
    const inner = obj.value
    if (inner == null) return v
    if (typeof inner === 'string') return inner
    if (typeof inner === 'number' || typeof inner === 'boolean') return inner
    if (typeof inner === 'object') {
        const r = inner as Record<string, unknown>
        if ('unit' in r && 'value' in r) {
            const num = Number(r.value)
            // Match Panda's runtime px→rem rounding (toFixed(6)) so the
            // className we resolve matches the pre-emitted utility class.
            if (r.unit === 'px') return `${+(num / 16).toFixed(6)}rem`
            return `${num}${r.unit}`
        }
        if ('r' in r && 'g' in r && 'b' in r) {
            const a = 'a' in r ? Number(r.a) : 1
            return a < 1
                ? `rgba(${r.r}, ${r.g}, ${r.b}, ${a})`
                : `rgb(${r.r}, ${r.g}, ${r.b})`
        }
    }
    return v
}
