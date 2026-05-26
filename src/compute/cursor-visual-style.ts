/**
 * @owner   src/compute/cursor-visual-style.ts
 * @does    Define the shared visual language for compute virtual cursor HUDs.
 * @needs   none
 * @feeds   docs cursor replay, macOS/Windows/Linux native overlay generators
 * @breaks  Divergent cursor visuals make overlay evidence feel inconsistent across providers.
 * @invariants Cursor visuals are pointer-skinned, hotspot-addressable, and state-addressable across all renderers.
 * @side-effects none
 * @perf    O(1)
 * @concurrency immutable constants
 * @test    tests/unit/compute-cursor-visual-style.test.ts
 * @stability experimental
 * @since   0.224.0
 */

export const COMPUTE_CURSOR_VISUAL_STYLE = {
  id: "mac-glass-pointer-v1",
  cursor: "mac-pointer",
  motion: "hotspot-spring-path",
  hotspot: { x: 0, y: 0 },
  states: ["observe", "move", "press", "wait", "success", "error"],
  palette: {
    ink: "#17130f",
    paper: "#f6f0e3",
    brass: "#c19a52",
    graphite: "#3c3832",
    signal: "#6f8f72",
    fault: "#a64d3b",
  },
  bannedTerms: [
    "unicli-neon-glass",
    "aqua-ring",
    "aperture-reticle-v1",
    "reticle",
    "compute-cursor-fill",
    "conic-gradient",
  ],
} as const;

export const COMPUTE_CURSOR_STYLE_ID = COMPUTE_CURSOR_VISUAL_STYLE.id;
