/**
 * @owner       src::engine::steps::select-xml
 * @does        Pipeline step that selects XML nodes via a subset of XPath 1.0 (descendant, attribute predicate, namespace-prefixed names) — needed for EPO OPS DOCDB, DPMA REST, KIPRIS legacy SOAP responses.
 * @needs       src/engine/step-registry.ts, src/engine/executor.ts, fast-xml-parser (npm)
 * @feeds       src/engine/steps/index.ts (barrel), adapter YAML pipelines (`- select-xml: { xpath: …, namespaces: {…} }`)
 * @breaks      throws PipelineError on malformed XML, invalid XPath expression, or namespace prefix not declared
 * @invariants  no XML external entity (XXE) expansion; parser configured with `processEntities: false`
 * @side-effects none beyond CPU
 * @perf        O(N) over the parsed DOM where N = node count; suitable for OPS responses up to a few MB; larger responses should be paginated upstream
 * @concurrency safe (pure function, no shared mutable state)
 * @test        tests/unit/engine/steps/select-xml.test.ts
 * @stability   stable
 * @since       2026-05-18
 */

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";

export interface SelectXmlConfig {
  /**
   * XPath-subset expression. Supported axes: `/`, `//`, `@attr`, `[predicate]`.
   * Predicates limited to attribute equality and positional index.
   */
  xpath: string;
  /**
   * Namespace prefix → URI map. EPO OPS uses `ops`, `exchange`, `epo`; KIPRIS
   * uses default + service-specific prefixes; INPI uses `inpi`.
   */
  namespaces?: Record<string, string>;
  /**
   * When the selected node set is a single element, unwrap to its plain
   * object form. Defaults to false (always returns an array of nodes).
   */
  unwrap_single?: boolean;
}

export const stepSelectXml: StepHandler<SelectXmlConfig> = (
  _ctx: PipelineContext,
  _config: SelectXmlConfig,
): PipelineContext => {
  throw new Error(
    "select-xml step: not yet implemented (M0 stub — wave-1-subagent-A will fill body using fast-xml-parser)",
  );
};

registerStep("select-xml", stepSelectXml);
