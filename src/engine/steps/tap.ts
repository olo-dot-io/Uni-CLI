import { registerStep, type StepHandler } from "../step-registry.js";
import { type PipelineContext, PipelineError } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

export interface TapConfig {
  store: string;
  action: string;
  capture: string;
  timeout?: number;
  select?: string;
  framework?: "pinia" | "vuex" | "auto";
  args?: unknown[];
}

export async function stepTap(
  ctx: PipelineContext,
  config: TapConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const { generateTapInterceptorJs } = await import("../interceptor.js");
  const capturePattern = evalTemplate(config.capture, ctx);
  const timeout = (config.timeout ?? 5) * 1000;
  const storeName = evalTemplate(config.store, ctx);
  const actionName = evalTemplate(config.action, ctx);
  // Reject non-identifier store/action names — JS injection guard.
  if (!/^[a-zA-Z_$][\w$]*$/.test(storeName)) {
    throw new PipelineError(`Invalid store name: "${storeName}"`, {
      step: -1,
      action: "tap",
      config,
      errorType: "expression_error",
      suggestion: "Store name must be a valid JavaScript identifier.",
      retryable: false,
      alternatives: [],
    });
  }
  if (!/^[a-zA-Z_$][\w$]*$/.test(actionName)) {
    throw new PipelineError(`Invalid action name: "${actionName}"`, {
      step: -1,
      action: "tap",
      config,
      errorType: "expression_error",
      suggestion: "Action name must be a valid JavaScript identifier.",
      retryable: false,
      alternatives: [],
    });
  }
  const framework = config.framework ?? "auto";
  const actionArgs = config.args
    ? config.args.map((a) => JSON.stringify(a)).join(", ")
    : "";

  const tap = generateTapInterceptorJs(capturePattern);

  const selectChain = config.select
    ? config.select
        .split(".")
        .map((k) => `?.[${JSON.stringify(k)}]`)
        .join("")
    : "";

  const piniaDiscovery = `
    const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
    if (!pinia) throw new Error('Pinia not found');
    const store = pinia._s.get('${storeName}');
    if (!store) throw new Error('Store "${storeName}" not found');
    await store['${actionName}'](${actionArgs});
  `;

  const vuexDiscovery = `
    const vStore = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$store;
    if (!vStore) throw new Error('Vuex store not found');
    await vStore.dispatch('${storeName}/${actionName}'${actionArgs ? ", " + actionArgs : ""});
  `;

  const autoDiscovery = `
    const app = document.querySelector('#app')?.__vue_app__;
    if (!app) throw new Error('No Vue app found');
    const pinia = app.config?.globalProperties?.$pinia;
    if (pinia && pinia._s.has('${storeName}')) {
      const store = pinia._s.get('${storeName}');
      await store['${actionName}'](${actionArgs});
    } else {
      const vStore = app.config?.globalProperties?.$store;
      if (vStore) {
        await vStore.dispatch('${storeName}/${actionName}'${actionArgs ? ", " + actionArgs : ""});
      } else {
        throw new Error('No Pinia or Vuex store found');
      }
    }
  `;

  const storeCode =
    framework === "pinia"
      ? piniaDiscovery
      : framework === "vuex"
        ? vuexDiscovery
        : autoDiscovery;

  const script = `(async () => {
    ${tap.setupVar}
    ${tap.fetchPatch}
    ${tap.xhrPatch}
    try {
      ${storeCode}
      const result = await Promise.race([
        ${tap.promiseVar},
        new Promise((_, reject) => setTimeout(() => reject(new Error('tap timeout')), ${timeout})),
      ]);
      return JSON.stringify(result${selectChain});
    } finally {
      ${tap.restorePatch}
    }
  })()`;

  const raw = await page.evaluate(script);
  let data: unknown;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  } else {
    data = raw;
  }

  return { ...ctx, data, page };
}

registerStep("tap", stepTap as StepHandler);
