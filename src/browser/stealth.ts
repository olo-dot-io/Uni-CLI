/**
 * Browser stealth scripts -- anti-detection evasions.
 *
 * Injected via Page.addScriptToEvaluateOnNewDocument to make
 * automated Chrome look like a normal user browser.
 */

/**
 * Core stealth script -- patches the most commonly detected signals.
 * Based on puppeteer-extra-stealth and community best practices.
 */
export const STEALTH_SCRIPT = `
// 1. Remove navigator.webdriver flag
Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
  configurable: true,
});

// 2. Mock chrome.runtime to look like a real extension-capable browser
if (!window.chrome) {
  window.chrome = {};
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: () => {},
    sendMessage: () => {},
    id: undefined,
  };
}

// 3. Fix navigator.plugins (headless Chrome has empty plugins)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    plugins.refresh = () => {};
    return plugins;
  },
  configurable: true,
});

// 4. Fix navigator.languages (sometimes empty in automation)
Object.defineProperty(navigator, 'languages', {
  get: () => ['en-US', 'en', 'zh-CN', 'zh'],
  configurable: true,
});

// 5. Mock permissions API query (Notification permission detection)
if (navigator.permissions) {
  const originalQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (parameters) => {
    if (parameters.name === 'notifications') {
      return Promise.resolve({ state: 'prompt', onchange: null });
    }
    return originalQuery(parameters);
  };
}

// 6. Fix Function.toString() detection
// Some sites check if native functions have been overridden
const originalToString = Function.prototype.toString;
const nativeToStringStr = 'function toString() { [native code] }';
Function.prototype.toString = function() {
  if (this === Function.prototype.toString) return nativeToStringStr;
  return originalToString.call(this);
};

// 7. Clean CDP/automation globals
(function() {
  var props = Object.getOwnPropertyNames(window);
  for (var i = 0; i < props.length; i++) {
    if (props[i].startsWith('cdc_') || props[i].startsWith('__playwright') ||
        props[i].startsWith('__puppeteer') || props[i] === '$chrome_asyncScriptInfo') {
      try { delete window[props[i]]; } catch(e) {}
    }
  }
  try { delete document.$cdc_asdjflasutopfhvcZLmcfl_; } catch(e) {}
  try { delete document.$chrome_asyncScriptInfo; } catch(e) {}
})();

// 8. Filter CDP script frames from Error.stack
(function() {
  var origStackDesc = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
  if (origStackDesc && origStackDesc.get) {
    var origGet = origStackDesc.get;
    Object.defineProperty(Error.prototype, 'stack', {
      get: function() {
        var stack = origGet.call(this);
        if (typeof stack !== 'string') return stack;
        return stack.split('\\n').filter(function(line) {
          return line.indexOf('__puppeteer_evaluation_script__') === -1 &&
                 line.indexOf('__playwright_evaluation_script__') === -1 &&
                 line.indexOf('pptr:') === -1;
        }).join('\\n');
      },
      configurable: true,
    });
  }
})();

// 9. Reserved for debugger statement stripping (no-op for now)

// 10. Normalize outerWidth/outerHeight to match realistic values
Object.defineProperty(window, 'outerWidth', {
  get: function() { return window.innerWidth; },
  configurable: true,
});
Object.defineProperty(window, 'outerHeight', {
  get: function() { return window.innerHeight + 85; },
  configurable: true,
});

// 11. Filter automation entries from Performance API
(function() {
  if (typeof Performance === 'undefined') return;
  var origGetEntries = Performance.prototype.getEntries;
  if (origGetEntries) {
    Performance.prototype.getEntries = function() {
      return origGetEntries.call(this).filter(function(e) {
        return e.name.indexOf('__puppeteer') === -1 && e.name.indexOf('pptr://') === -1;
      });
    };
  }
  var origGetByType = Performance.prototype.getEntriesByType;
  if (origGetByType) {
    Performance.prototype.getEntriesByType = function(type) {
      return origGetByType.call(this, type).filter(function(e) {
        return e.name.indexOf('__puppeteer') === -1 && e.name.indexOf('pptr://') === -1;
      });
    };
  }
})();

// 12. Clean document-level CDP markers
(function() {
  var docProps = Object.getOwnPropertyNames(document);
  for (var i = 0; i < docProps.length; i++) {
    if (docProps[i].startsWith('$cdc_') || docProps[i].startsWith('$chrome_')) {
      try { delete document[docProps[i]]; } catch(e) {}
    }
  }
})();

// 13. Ensure iframe contentWindow.chrome consistency
(function() {
  var origDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (origDesc && origDesc.get) {
    var origGet = origDesc.get;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        var win = origGet.call(this);
        if (win && !win.chrome) {
          try {
            win.chrome = {
              runtime: { connect: function(){}, sendMessage: function(){}, id: undefined }
            };
          } catch(e) {}
        }
        return win;
      },
      configurable: true,
    });
  }
})();
`;

/**
 * Inject stealth scripts into a CDP client.
 * Should be called immediately after connecting, before any navigation.
 */
export async function injectStealth(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: STEALTH_SCRIPT,
  });
}
