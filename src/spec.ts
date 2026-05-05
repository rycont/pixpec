/**
 * Browser-safe pixpec entry — only the `defineComponent` factory and types.
 *
 * The DS imports from here in everything that ends up in browser code paths
 * (component `index.ts`, `noise.ts`, `cases.ts`). The main `pixpec` entry
 * pulls in Node-only deps (Playwright, opencv-js, cfigma subprocess) and
 * must NOT be imported from any module Vite serves to the browser.
 */
import { createElement, type ComponentType, type ReactNode } from 'react'
export { defineComponent, dE00 } from './types.ts'
export type {
  Component,
  Case,
  CaseResult,
  NoiseFn,
  Metric,
  DE00,
} from './types.ts'

/**
 * Helper: build a fixed-size box wrapper FC for a Case. Common pattern for
 * components that need explicit dim parity with figma frame size, optional
 * bg/color (color cascades into Icon's currentColor SVGs).
 *
 *   wrapper: boxWrapper({ width: 64, height: 64, color: '#292a2e' })
 */
export interface BoxWrapperOptions {
  /** Omit when the rendered root is HUG along this axis — wrapper shrinks to
   * content (intrinsic). Provide for FIXED (figma resolved px) or FILL (bound
   * the FILL). */
  width?: number
  height?: number
  padding?: number
  bg?: string
  color?: string
}
export function boxWrapper(o: BoxWrapperOptions): ComponentType<{ children: ReactNode }> {
  const style: Record<string, unknown> = {
    padding: o.padding ?? 0,
    background: o.bg ?? 'white',
    ...(o.color ? { color: o.color } : {}),
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
  if (o.width !== undefined) style.width = o.width
  if (o.height !== undefined) style.height = o.height
  return ({ children }) => createElement('div', { style }, children)
}
