/**
 * Scene — thin compatibility shim.
 *
 * The background was originally composed of three separate components
 * (`CameraRig` + `ParticleField` + `CoreObject`). It is now a single
 * flow-field nebula rendered by `SceneCanvas`, which owns the Canvas, the
 * Bloom pipeline and the particle system.
 *
 * This file is kept as the lazy-loaded entry point so `App.tsx` does not need to
 * know the canvas layer's internal naming, and so a future scene swap stays a
 * one-line change here.
 *
 * It exports the default ONLY. It used to also re-export the named `Scene`, which meant
 * the module had two entry points and neither was authoritative -- the review's LD-06.
 * `App.tsx` uses the default; anything else that wants `SceneCanvas` can import it from
 * its own file and skip the indirection.
 */
export { default } from '@/components/canvas/SceneCanvas'
