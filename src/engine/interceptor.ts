/**
 * Interceptor Module — Dual fetch + XHR injection with anti-detection stealth.
 *
 * Generates JavaScript strings for injecting into browser page context to
 * intercept both window.fetch and XMLHttpRequest network requests.
 *
 * Anti-detection techniques:
 *   - WeakMap-based toString disguise (prevents Function.prototype.toString detection)
 *   - enumerable: false on all injected properties
 *   - Idempotency guard to prevent double-patching
 */

/**
 * Generate a persistent global interceptor IIFE.
 *
 * Patches window.fetch and XMLHttpRequest to capture JSON responses whose
 * URL contains `pattern`. Results accumulate in window.__unicli_intercepted.
 * Safe to inject multiple times — idempotency guard prevents double-patching.
 */
export function generateInterceptorJs(pattern: string): string {
  const patternJson = JSON.stringify(pattern);
  return `(function() {
  if (window.__unicli_interceptor_patched) return;
  window.__unicli_interceptor_patched = true;

  window.__unicli_intercepted = [];

  // WeakMap for toString disguise — maps patched fn -> original fn
  if (!window.__dFns) {
    window.__dFns = new WeakMap();
    var _origToString = Function.prototype.toString;
    Object.defineProperty(Function.prototype, 'toString', {
      value: function() {
        var orig = window.__dFns.get(this);
        return orig ? _origToString.call(orig) : _origToString.call(this);
      },
      enumerable: false,
      writable: true,
      configurable: true
    });
  }

  function __defHidden(obj, key, val) {
    Object.defineProperty(obj, key, {
      value: val,
      enumerable: false,
      writable: true,
      configurable: true
    });
  }

  function __disguise(fn, original) {
    window.__dFns.set(fn, original);
    return fn;
  }

  var __pattern = ${patternJson};

  // --- Patch window.fetch ---
  var __origFetch = window.fetch;
  __defHidden(window, '__unicli_origFetch', __origFetch);
  var __patchedFetch = __disguise(async function() {
    var resp = await __origFetch.apply(this, arguments);
    var url = '';
    var firstArg = arguments[0];
    if (typeof firstArg === 'string') {
      url = firstArg;
    } else if (firstArg && typeof firstArg === 'object' && firstArg.url) {
      url = firstArg.url;
    }
    if (url.includes(__pattern)) {
      try {
        var clone = resp.clone();
        var json = await clone.json();
        window.__unicli_intercepted.push({ url: url, data: json, ts: Date.now() });
      } catch (_e) {}
    }
    return resp;
  }, __origFetch);
  __defHidden(window, 'fetch', __patchedFetch);

  // --- Patch XMLHttpRequest ---
  var __origOpen = XMLHttpRequest.prototype.open;
  var __origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = __disguise(function(method, url) {
    __defHidden(this, '__unicli_url', typeof url === 'string' ? url : String(url));
    return __origOpen.apply(this, arguments);
  }, __origOpen);

  XMLHttpRequest.prototype.send = __disguise(function() {
    var xhr = this;
    var captureUrl = xhr.__unicli_url || '';
    if (captureUrl.includes(__pattern)) {
      xhr.addEventListener('load', function() {
        try {
          var json = JSON.parse(xhr.responseText);
          window.__unicli_intercepted.push({ url: captureUrl, data: json, ts: Date.now() });
        } catch (_e) {}
      });
    }
    return __origSend.apply(this, arguments);
  }, __origSend);
})();`;
}

/**
 * Result type for generateTapInterceptorJs — code snippets for the tap step.
 */
export interface TapInterceptorSnippets {
  /** Variable declarations: let __captured, __captureResolve, __capturePromise */
  setupVar: string;
  /** Name of the captured variable: "__captured" */
  capturedVar: string;
  /** Name of the promise variable: "__capturePromise" */
  promiseVar: string;
  /** Name of the resolve variable: "__captureResolve" */
  resolveVar: string;
  /** fetch patch snippet (saves origFetch, installs capturing wrapper) */
  fetchPatch: string;
  /** XHR patch snippet (saves origXhrOpen/Send, installs capturing wrapper) */
  xhrPatch: string;
  /** Restore snippet (restores all originals) */
  restorePatch: string;
}

/**
 * Generate self-contained code snippets for the tap step.
 *
 * Returns individual snippets (not a full IIFE) that can be composed by the
 * tap step logic. First capture immediately calls __captureResolve() for
 * Promise.race patterns.
 */
export function generateTapInterceptorJs(
  pattern: string,
): TapInterceptorSnippets {
  const patternJson = JSON.stringify(pattern);

  const setupVar = `
var __captured = null;
var __captureResolve;
var __capturePromise = new Promise(function(resolve) { __captureResolve = resolve; });
`.trim();

  const fetchPatch = `
var origFetch = window.fetch;
window.fetch = async function() {
  var resp = await origFetch.apply(this, arguments);
  var url = '';
  var firstArg = arguments[0];
  if (typeof firstArg === 'string') { url = firstArg; }
  else if (firstArg && typeof firstArg === 'object' && firstArg.url) { url = firstArg.url; }
  if (url.includes(${patternJson})) {
    try {
      var clone = resp.clone();
      var json = await clone.json();
      if (!__captured) { __captured = { url: url, data: json, ts: Date.now() }; __captureResolve(__captured); }
    } catch (_e) {}
  }
  return resp;
};
`.trim();

  const xhrPatch = `
var origXhrOpen = XMLHttpRequest.prototype.open;
var origXhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url) {
  Object.defineProperty(this, '__tap_url', { value: typeof url === 'string' ? url : String(url), enumerable: false, writable: true, configurable: true });
  return origXhrOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function() {
  var xhr = this;
  var captureUrl = xhr.__tap_url || '';
  if (captureUrl.includes(${patternJson})) {
    xhr.addEventListener('load', function() {
      try {
        var json = JSON.parse(xhr.responseText);
        if (!__captured) { __captured = { url: captureUrl, data: json, ts: Date.now() }; __captureResolve(__captured); }
      } catch (_e) {}
    });
  }
  return origXhrSend.apply(this, arguments);
};
`.trim();

  const restorePatch = `
window.fetch = origFetch;
XMLHttpRequest.prototype.open = origXhrOpen;
XMLHttpRequest.prototype.send = origXhrSend;
`.trim();

  return {
    setupVar,
    capturedVar: "__captured",
    promiseVar: "__capturePromise",
    resolveVar: "__captureResolve",
    fetchPatch,
    xhrPatch,
    restorePatch,
  };
}

/**
 * Generate JS that reads and clears the intercepted array, returning JSON.
 *
 * @param arrayName - window property name (default: "__unicli_intercepted")
 */
export function generateReadInterceptedJs(
  arrayName = "__unicli_intercepted",
): string {
  const nameJson = JSON.stringify(arrayName);
  return `(function() {
  var data = window[${nameJson}] || [];
  window[${nameJson}] = [];
  return JSON.stringify(data);
})()`;
}
