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
