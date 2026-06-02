/**
 * @owner   src/engine/objective/index.ts
 * @does    Exposes objective workflow planning, delivery conversion, and agent output helpers.
 * @needs   src/engine/objective/{catalog,delivery,planner,output,types}.ts
 * @feeds   src/commands/do.ts, tests, and future objective execution commands.
 * @breaks  Missing exports force callers to bypass the objective bounded context.
 * @invariants The CLI imports from this barrel instead of reaching into workflow internals.
 * @side-effects none.
 * @perf    O(1) module re-export surface.
 * @concurrency module-load only.
 * @test    tests/unit/objective-compiler.test.ts
 * @stability experimental
 * @since   2026-06-01
 */

export * from "./catalog.js";
export * from "./delivery.js";
export * from "./planner.js";
export * from "./output.js";
export * from "./types.js";
