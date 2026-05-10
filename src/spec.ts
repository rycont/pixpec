/**
 * Browser-safe pixpec entry — only the `defineComponent` factory and types.
 *
 * The DS imports from here in everything that ends up in browser code paths
 * (component `index.ts`, `cases.ts`). The main `pixpec` entry pulls in
 * Node-only deps (Playwright, opencv-js, cfigma subprocess) and must NOT be
 * imported from any module Vite serves to the browser.
 */
import { createElement, type ComponentType, type ReactNode } from 'react'
export { defineComponent } from './types.ts'
export type { Component, Case } from './types.ts'

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
  // Emit dimensional values as rem so verify-mode html font-size scaling
  // (codegen Phase 2) supersamples the wrapper alongside the codegen'd JSX.
  // 16 is CSS default html font-size; production renders identically.
  const px2rem = (v: number) => `${+(v / 16).toFixed(6)}rem`
  const style: Record<string, unknown> = {
    padding: typeof o.padding === 'number' ? px2rem(o.padding) : '0rem',
    background: o.bg ?? 'white',
    ...(o.color ? { color: o.color } : {}),
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Positioning context for absolutely-positioned root children (e.g. the
    // rotation-wrap codegen emits for rotated FRAME/COMPONENT roots).
    position: 'relative',
    // Clip overflow so an authored thin frame (e.g. 600×1 with content
    // overflowing 30px) gives the screenshot the wrapper's bbox dim,
    // not the overflowing children's. Matches figma exportAsync's bbox
    // (useAbsoluteBounds) behavior.
    overflow: 'hidden',
  }
  if (o.width !== undefined) style.width = px2rem(o.width)
  if (o.height !== undefined) style.height = px2rem(o.height)
  return ({ children }) => createElement('div', { style }, children)
}
