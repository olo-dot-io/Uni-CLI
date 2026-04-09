/**
 * Frontend Framework Detection + Store Discovery.
 *
 * Returns JS source strings for page.evaluate() — the caller executes them.
 * Ported from Open-CLI's scripts/store.ts + detectFramework, adapted for
 * Uni-CLI's evaluate API.
 */

export interface FrameworkInfo {
  react: boolean;
  vue: boolean;
  next: boolean;
  nuxt: boolean;
  svelte: boolean;
  angular: boolean;
}

export interface StoreInfo {
  type: "pinia" | "vuex";
  id: string;
  actions: string[];
  stateKeys: string[];
}

/** JS string that returns FrameworkInfo when evaluated in page context. */
export function generateFrameworkDetectJs(): string {
  return `(() => {
  try {
    return {
      react: !!(document.querySelector('[data-reactroot]') || document.querySelector('[data-reactid]') || window.__REACT_DEVTOOLS_GLOBAL_HOOK__),
      vue: !!(window.__vue_app__ || (document.querySelector('#app') && document.querySelector('#app').__vue_app__) || window.__VUE__),
      next: !!(window.__NEXT_DATA__ || document.querySelector('#__next')),
      nuxt: !!(window.__NUXT__ || window.__nuxt),
      svelte: !!(document.querySelector('[class*="svelte-"]') || window.__svelte),
      angular: !!(window.ng || document.querySelector('[ng-version]') || window.getAllAngularRootElements),
    };
  } catch (e) {
    return { react: false, vue: false, next: false, nuxt: false, svelte: false, angular: false };
  }
})()`;
}

/** JS string that returns StoreInfo[] when evaluated in page context. */
export function generateStoreDiscoverJs(): string {
  return `(() => {
  var stores = [];
  try {
    var app = document.querySelector('#app');
    var vueApp = app && app.__vue_app__;
    if (vueApp) {
      var pinia = vueApp.config && vueApp.config.globalProperties && vueApp.config.globalProperties.$pinia;
      if (pinia && pinia._s) {
        pinia._s.forEach(function(store, id) {
          if (id.charAt(0) === '$' || id.charAt(0) === '_') return;
          var actions = [];
          var stateKeys = [];
          Object.keys(store).forEach(function(key) {
            if (key.charAt(0) === '$' || key.charAt(0) === '_') return;
            if (typeof store[key] === 'function') actions.push(key);
            else stateKeys.push(key);
          });
          stores.push({ type: 'pinia', id: id, actions: actions.slice(0, 20), stateKeys: stateKeys.slice(0, 15) });
        });
      }
      var vuexStore = vueApp.config && vueApp.config.globalProperties && vueApp.config.globalProperties.$store;
      if (vuexStore && vuexStore._modules && vuexStore._modules.root && vuexStore._modules.root._children) {
        var children = vuexStore._modules.root._children;
        Object.keys(children).forEach(function(id) {
          var mod = children[id];
          var actions = mod._rawModule && mod._rawModule.actions ? Object.keys(mod._rawModule.actions) : [];
          var stateKeys = mod.state ? Object.keys(mod.state) : [];
          stores.push({ type: 'vuex', id: id, actions: actions.slice(0, 20), stateKeys: stateKeys.slice(0, 15) });
        });
      }
    }
  } catch (e) {}
  return stores;
})()`;
}

/** Check if Vue store discovery should be attempted. */
export function hasVueStores(framework: FrameworkInfo): boolean {
  return framework.vue;
}
