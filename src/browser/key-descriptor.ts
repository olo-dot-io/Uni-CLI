/**
 * @owner       src::browser::key-descriptor
 * @does        Compile one bounded logical key plus modifiers into the shared CDP key-event pair used by managed and Chrome-extension targets.
 * @needs       CDP Input.dispatchKeyEvent key/code/virtual-key/modifier/editing-command contract
 * @feeds       src/browser/page.ts, extension/src/chrome-controller.ts
 * @breaks      Unknown named keys remain explicit pass-through values with virtual key code zero; supported physical keys and primary editing shortcuts never silently diverge between providers.
 * @invariants  Managed and Chrome providers emit identical pairs; printable unmodified characters carry text only on keyDown; keyUp never repeats text or editing commands; modifier aliases compile to the CDP bitmask.
 * @side-effects none
 * @perf        O(modifier count), bounded by the caller schema to four modifiers.
 * @test        tests/unit/browser-page.test.ts, tests/integration/browser-extension-background.test.ts
 * @stability   stable
 * @since       2026-07-16
 */

export interface BrowserKeyEventPair {
  down: Record<string, unknown>;
  up: Record<string, unknown>;
}

interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = Object.freeze({
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  CapsLock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
});

const MODIFIER_BITS: Readonly<Record<string, number>> = Object.freeze({
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  shift: 8,
});

const PRINTABLE_KEYS: Readonly<
  Record<string, { code: string; keyCode: number; shifted?: string }>
> = Object.freeze({
  "`": { code: "Backquote", keyCode: 192, shifted: "~" },
  "1": { code: "Digit1", keyCode: 49, shifted: "!" },
  "2": { code: "Digit2", keyCode: 50, shifted: "@" },
  "3": { code: "Digit3", keyCode: 51, shifted: "#" },
  "4": { code: "Digit4", keyCode: 52, shifted: "$" },
  "5": { code: "Digit5", keyCode: 53, shifted: "%" },
  "6": { code: "Digit6", keyCode: 54, shifted: "^" },
  "7": { code: "Digit7", keyCode: 55, shifted: "&" },
  "8": { code: "Digit8", keyCode: 56, shifted: "*" },
  "9": { code: "Digit9", keyCode: 57, shifted: "(" },
  "0": { code: "Digit0", keyCode: 48, shifted: ")" },
  "-": { code: "Minus", keyCode: 189, shifted: "_" },
  "=": { code: "Equal", keyCode: 187, shifted: "+" },
  "[": { code: "BracketLeft", keyCode: 219, shifted: "{" },
  "]": { code: "BracketRight", keyCode: 221, shifted: "}" },
  "\\": { code: "Backslash", keyCode: 220, shifted: "|" },
  ";": { code: "Semicolon", keyCode: 186, shifted: ":" },
  "'": { code: "Quote", keyCode: 222, shifted: '"' },
  ",": { code: "Comma", keyCode: 188, shifted: "<" },
  ".": { code: "Period", keyCode: 190, shifted: ">" },
  "/": { code: "Slash", keyCode: 191, shifted: "?" },
});

export function browserKeyEventPair(
  key: string,
  modifiers: readonly string[] = [],
): BrowserKeyEventPair {
  const modifierMask = modifiers.reduce(
    (mask, modifier) => mask | (MODIFIER_BITS[modifier.toLowerCase()] ?? 0),
    0,
  );
  const definition = keyDefinition(key, (modifierMask & 8) !== 0);
  const textAllowed = (modifierMask & 7) === 0;
  const text = textAllowed ? definition.text : undefined;
  const commands = editingCommands(definition.code, modifierMask);
  const common = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    ...(modifierMask === 0 ? {} : { modifiers: modifierMask }),
  };
  return {
    down: {
      type: text === undefined ? "rawKeyDown" : "keyDown",
      ...common,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
      ...(commands.length === 0 ? {} : { commands }),
    },
    up: { type: "keyUp", ...common },
  };
}

function keyDefinition(key: string, shifted: boolean): KeyDefinition {
  const named = NAMED_KEYS[key];
  if (named) return named;
  const functionKey = /^F([1-9]|1[0-2])$/.exec(key);
  if (functionKey) {
    return { key, code: key, keyCode: 111 + Number(functionKey[1]) };
  }
  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    const rendered = shifted ? upper : key;
    return {
      key: rendered,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: rendered,
    };
  }
  const direct = PRINTABLE_KEYS[key];
  if (direct) {
    const rendered = shifted && direct.shifted ? direct.shifted : key;
    return { key: rendered, ...direct, text: rendered };
  }
  const base = Object.entries(PRINTABLE_KEYS).find(
    ([, value]) => value.shifted === key,
  );
  if (base) {
    return { key, code: base[1].code, keyCode: base[1].keyCode, text: key };
  }
  return {
    key,
    code: key,
    keyCode: 0,
    ...([...key].length === 1 ? { text: key } : {}),
  };
}

function editingCommands(code: string, modifiers: number): string[] {
  if (modifiers === 0 && code === "Backspace") return ["deleteBackward"];
  if (modifiers === 0 && code === "Delete") return ["deleteForward"];
  if (modifiers === 4 && code === "KeyA") return ["selectAll"];
  if (modifiers === 4 && code === "KeyZ") return ["undo"];
  if (modifiers === 12 && code === "KeyZ") return ["redo"];
  return [];
}
