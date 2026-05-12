/**
 * Browser-safe pixpec entry — only the `defineComponent` factory and types.
 *
 * The DS imports from here in everything that ends up in browser code paths
 * (component `index.ts`, `cases.ts`). The main `pixpec` entry pulls in
 * Node-only deps (Playwright, opencv-js, cfigma subprocess) and must NOT be
 * imported from any module Vite serves to the browser.
 */
import { z } from "zod";
export { z };
export { defineComponent } from "./types.ts";
export type {
  Component,
  Case,
  Variant,
  NodeBinding,
  NodeBindings,
  NodeBindingSurface,
  CaseRenderSpec,
  RenderBoxSpec,
} from "./types.ts";
