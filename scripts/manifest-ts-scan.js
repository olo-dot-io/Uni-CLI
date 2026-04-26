import ts from "typescript";

const ELECTRON_DESKTOP_BASE_COMMANDS = [
  [
    "open-app",
    "Open desktop Electron app with CDP enabled. 打开桌面版 Electron app 并启用 CDP 控制",
  ],
  [
    "status-app",
    "Inspect desktop Electron app title, URL, visible controls, and text. 查看桌面版状态和内容",
  ],
  [
    "dump",
    "Dump visible DOM text from desktop Electron app. 读取桌面版可见文本内容",
  ],
  [
    "snapshot-app",
    "List visible clickable text, buttons, inputs, and regions in desktop Electron app. 枚举桌面版可交互控件",
  ],
  [
    "click-text",
    "Click visible text, aria-label, title, or button content in desktop Electron app. 按文本点击桌面版控件",
  ],
  [
    "type-text",
    "Type text into the focused field or a text-matched target in desktop Electron app. 向桌面版输入文本",
  ],
  [
    "press",
    "Press a key in desktop Electron app, with optional modifiers. 向桌面版发送按键",
  ],
];

const ELECTRON_DESKTOP_MEDIA_COMMANDS = [
  [
    "play-liked",
    "Open liked songs and play the liked playlist in desktop Electron music app. 打开我喜欢的音乐并播放",
  ],
  ["play", "Start playback in desktop Electron music app. 播放音乐"],
  ["pause", "Pause playback in desktop Electron music app. 暂停音乐"],
  ["toggle", "Toggle playback in desktop Electron music app. 切换播放暂停"],
  ["next", "Skip to next track in desktop Electron music app. 下一首"],
  ["prev", "Skip to previous track in desktop Electron music app. 上一首"],
];

const AI_CHAT_BASE_COMMANDS = [
  ["ask", "Send a prompt and wait for response in desktop AI chat app"],
  ["send", "Send text without waiting in desktop AI chat app"],
  ["read", "Read the latest response from desktop AI chat app"],
  ["status", "Inspect desktop AI chat app status"],
  ["screenshot", "Capture a screenshot from desktop AI chat app"],
  ["dump", "Dump visible text from desktop AI chat app"],
];

const AI_CHAT_MODEL_COMMAND = [
  "model",
  "Switch or inspect the model in desktop AI chat app",
];

const AI_CHAT_NEW_COMMAND = ["new", "Start a new desktop AI chat"];

function extractElectronDesktopRegistrations(source) {
  const out = [];
  const re =
    /registerElectronDesktopCommands\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*(\{[\s\S]*?\})\s*)?\)/g;
  for (const match of source.matchAll(re)) {
    const site = match[1];
    const options = match[2] ?? "";
    const displayName =
      options.match(/displayName:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? site;
    const hasMedia = /\bmedia\s*:/.test(options);
    const commands = ELECTRON_DESKTOP_BASE_COMMANDS.map(([name, desc]) => ({
      name,
      description: `${desc} ${displayName}`,
      strategy: "public",
      type: "web-api",
    }));
    if (hasMedia) {
      commands.push(
        ...ELECTRON_DESKTOP_MEDIA_COMMANDS.map(([name, desc]) => ({
          name,
          description: `${desc} ${displayName}`,
          strategy: "public",
          type: "web-api",
        })),
      );
    }
    out.push({ site, commands });
  }
  return out;
}

function literalText(node) {
  if (!node) return "";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return "";
}

function propertyNameText(name) {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return "";
}

function getObjectProperty(obj, prop) {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    if (propertyNameText(p.name) === prop) return p.initializer;
  }
  return undefined;
}

function getObjectString(obj, prop) {
  return literalText(getObjectProperty(obj, prop));
}

function getObjectBoolean(obj, prop) {
  const node = getObjectProperty(obj, prop);
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function literalValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    const values = [];
    for (const element of node.elements) {
      const value = literalValue(element);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  return undefined;
}

function getStringArray(obj, prop) {
  const value = literalValue(getObjectProperty(obj, prop));
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item) => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function getObjectStrategy(obj) {
  const node = getObjectProperty(obj, "strategy");
  if (!node) return "public";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text.toLowerCase();
  }
  return "public";
}

function getObjectArgs(obj) {
  const node = getObjectProperty(obj, "args");
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined;

  const args = [];
  for (const element of node.elements) {
    if (!ts.isObjectLiteralExpression(element)) return undefined;
    const name = getObjectString(element, "name");
    if (!name) return undefined;

    const arg = { name };
    const type = getObjectString(element, "type");
    if (type) arg.type = type;
    const defaultValue = literalValue(getObjectProperty(element, "default"));
    if (defaultValue !== undefined) arg.default = defaultValue;
    const required = getObjectBoolean(element, "required");
    if (required !== undefined) arg.required = required;
    const positional = getObjectBoolean(element, "positional");
    if (positional !== undefined) arg.positional = positional;
    const choices = getStringArray(element, "choices");
    if (choices) arg.choices = choices;
    const description = getObjectString(element, "description");
    if (description) arg.description = description;
    const format = getObjectString(element, "format");
    if (format) arg.format = format;
    const kind = getObjectString(element, "x-unicli-kind");
    if (kind) arg["x-unicli-kind"] = kind;
    const accepts = getStringArray(element, "x-unicli-accepts");
    if (accepts) arg["x-unicli-accepts"] = accepts;

    args.push(arg);
  }

  return args;
}

function hasObjectProperty(obj, prop) {
  return getObjectProperty(obj, prop) !== undefined;
}

function makeAiChatCommands(displayName, hasModel, hasNew) {
  const suffix = displayName ? ` ${displayName}` : "";
  const commands = AI_CHAT_BASE_COMMANDS.map(([name, desc]) => ({
    name,
    description: `${desc}${suffix}`,
    strategy: "public",
    type: "web-api",
  }));
  if (hasModel) {
    commands.push({
      name: AI_CHAT_MODEL_COMMAND[0],
      description: `${AI_CHAT_MODEL_COMMAND[1]}${suffix}`,
      strategy: "public",
      type: "web-api",
    });
  }
  if (hasNew) {
    commands.push({
      name: AI_CHAT_NEW_COMMAND[0],
      description: `${AI_CHAT_NEW_COMMAND[1]}${suffix}`,
      strategy: "public",
      type: "web-api",
    });
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}

export function extractTsRegistrations(source, fallbackSite, fallbackCommand) {
  const out = extractElectronDesktopRegistrations(source);
  const sf = ts.createSourceFile(
    `${fallbackSite}/${fallbackCommand}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const first = node.arguments[0];
      const second = node.arguments[1];

      if (callee === "cli" && first && ts.isObjectLiteralExpression(first)) {
        const site = getObjectString(first, "site") || fallbackSite;
        const name = getObjectString(first, "name") || fallbackCommand;
        out.push({
          site,
          commands: [
            {
              name,
              description: getObjectString(first, "description"),
              strategy: getObjectStrategy(first),
              type: "web-api",
              browser: getObjectBoolean(first, "browser"),
              columns: getStringArray(first, "columns"),
              args: getObjectArgs(first),
              pipeline_steps: 0,
              adapter_path: `src/adapters/${fallbackSite}/${fallbackCommand}.ts`,
            },
          ],
        });
      }

      if (
        callee === "registerAIChatCommands" &&
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ) {
        const site = first.text;
        const options =
          second && ts.isObjectLiteralExpression(second) ? second : undefined;
        const displayName = options
          ? getObjectString(options, "displayName") || site
          : site;
        out.push({
          site,
          commands: makeAiChatCommands(
            displayName,
            options ? hasObjectProperty(options, "modelSelector") : false,
            options ? hasObjectProperty(options, "newChatSelector") : false,
          ),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return out;
}

export function dedupeCommands(commands) {
  const seen = new Set();
  const out = [];
  for (const cmd of commands) {
    if (!cmd.name || seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
