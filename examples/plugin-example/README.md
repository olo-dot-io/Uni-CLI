# @zenalexa/unicli-plugin-example

Minimal Uni-CLI plugin — registers a `reverse` pipeline step.

## Install

```bash
npm install @zenalexa/unicli @zenalexa/unicli-plugin-example
npm run build
```

## Use

Preload the plugin before any pipeline executes:

```bash
node --import @zenalexa/unicli-plugin-example $(which unicli) example demo
```

From a custom host script:

```ts
import "@zenalexa/unicli-plugin-example";
import { runPipeline } from "@zenalexa/unicli/engine";

await runPipeline(
  [{ fetch: { url: "https://example.com/items" } }, { reverse: {} }],
  { args: {}, vars: {} },
);
```

`reverse` returns the input array reversed; non-array data passes
through. See `docs/PLUGIN.md` in the main repo for the stability
contract.
