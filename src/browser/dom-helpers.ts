/**
 * DOM helper functions -- returns JS code strings for injection
 * into the browser page context via evaluate().
 *
 * Similar pattern to snapshot.ts: generates self-contained IIFE strings.
 */

/**
 * Returns a JS string that waits for DOM to stabilize.
 * Uses MutationObserver — resolves when no mutations for quietMs, or after maxMs.
 *
 * The returned code is a self-contained IIFE returning a Promise,
 * suitable for page.evaluate() with awaitPromise: true.
 *
 * @param maxMs  Hard timeout — resolve regardless after this many ms (default 5000)
 * @param quietMs  Quiet period — resolve when no mutations for this long (default 500)
 */
export function waitForDomStableJs(maxMs?: number, quietMs?: number): string {
  const max =
    Number.isFinite(Number(maxMs)) && Number(maxMs) > 0
      ? Math.trunc(Number(maxMs))
      : 1000;
  const quiet =
    Number.isFinite(Number(quietMs)) && Number(quietMs) > 0
      ? Math.trunc(Number(quietMs))
      : 500;

  return `(()=>new Promise(resolve=>{
  const MAX=${max};
  const QUIET=${quiet};
  if(!document.body){resolve();return}
  let timer=null;
  const obs=new MutationObserver(()=>{
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(()=>{obs.disconnect();resolve()},QUIET);
  });
  obs.observe(document.body,{childList:true,subtree:true,attributes:true});
  timer=setTimeout(()=>{obs.disconnect();resolve()},QUIET);
  setTimeout(()=>{if(timer!==null)clearTimeout(timer);obs.disconnect();resolve()},MAX);
}))()`;
}
