import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
    [
      {
        name: "limit",
        type: "str",
        required: false,
        positional: false,
        description: "Maximum text characters to return",
      },
    ],
  ],
  [
    "snapshot-app",
    "List visible clickable text, buttons, inputs, and regions in desktop Electron app. 枚举桌面版可交互控件",
  ],
  [
    "click-text",
    "Click visible text, aria-label, title, or button content in desktop Electron app. 按文本点击桌面版控件",
    [
      {
        name: "text",
        type: "str",
        required: true,
        positional: true,
        description: "Visible text, aria-label, or title to click",
      },
    ],
  ],
  [
    "type-text",
    "Type text into the focused field or a text-matched target in desktop Electron app. 向桌面版输入文本",
    [
      {
        name: "text",
        type: "str",
        required: true,
        positional: true,
        description: "Text to type",
      },
      {
        name: "target",
        type: "str",
        required: false,
        positional: false,
        description: "Optional visible text to click before typing",
      },
    ],
  ],
  [
    "press",
    "Press a key in desktop Electron app, with optional modifiers. 向桌面版发送按键",
    [
      {
        name: "key",
        type: "str",
        required: true,
        positional: true,
        description: "Key name",
      },
      {
        name: "modifiers",
        type: "str",
        required: false,
        positional: false,
        description: "Comma-separated modifiers such as meta,shift",
      },
    ],
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
  [
    "ask",
    "Send a prompt and wait for response in desktop AI chat app",
    [{ name: "prompt", type: "str", required: true, positional: true }],
  ],
  [
    "send",
    "Send text without waiting in desktop AI chat app",
    [{ name: "text", type: "str", required: true, positional: true }],
  ],
  ["read", "Read the latest response from desktop AI chat app"],
  ["status", "Inspect desktop AI chat app status"],
  [
    "screenshot",
    "Capture a screenshot from desktop AI chat app",
    [
      {
        name: "path",
        type: "str",
        required: false,
        positional: true,
      },
    ],
  ],
  ["dump", "Dump visible text from desktop AI chat app"],
];

const AI_CHAT_MODEL_COMMAND = [
  "model",
  "Switch or inspect the model in desktop AI chat app",
  [{ name: "name", type: "str", required: false, positional: true }],
];

const AI_CHAT_NEW_COMMAND = ["new", "Start a new desktop AI chat"];

function commandMetadata(adapterPath) {
  return {
    adapter_path: adapterPath,
    target_surface: "desktop",
  };
}

function extractElectronDesktopRegistrations(
  source,
  fallbackSite,
  fallbackCommand,
) {
  const out = [];
  const metadata = commandMetadata(
    `src/adapters/${fallbackSite}/${fallbackCommand}.ts`,
  );
  const re =
    /registerElectronDesktopCommands\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*(\{[\s\S]*?\})\s*)?\)/g;
  for (const match of source.matchAll(re)) {
    const site = match[1];
    const options = match[2] ?? "";
    const displayName =
      options.match(/displayName:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? site;
    const hasMedia = /\bmedia\s*:/.test(options);
    const commands = ELECTRON_DESKTOP_BASE_COMMANDS.map(
      ([name, desc, args]) => ({
        name,
        description: `${desc} ${displayName}`,
        strategy: "public",
        type: "web-api",
        ...metadata,
        ...(args ? { args } : {}),
      }),
    );
    if (hasMedia) {
      commands.push(
        ...ELECTRON_DESKTOP_MEDIA_COMMANDS.map(([name, desc]) => ({
          name,
          description: `${desc} ${displayName}`,
          strategy: "public",
          type: "web-api",
          ...metadata,
        })),
      );
    }
    out.push({ site, commands });
  }
  return out;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function literalText(node) {
  node = unwrapExpression(node);
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
    if (ts.isPropertyAssignment(p) && propertyNameText(p.name) === prop) {
      return p.initializer;
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop) {
      return p.name;
    }
  }
  return undefined;
}

function literalTextWithBindings(node, bindings = new Map()) {
  node = unwrapExpression(node);
  if (!node) return "";
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? "";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = literalTextWithBindings(span.expression, bindings);
      if (!value) return "";
      text += value + span.literal.text;
    }
    return text;
  }
  return "";
}

function getObjectString(obj, prop, bindings) {
  return literalTextWithBindings(getObjectProperty(obj, prop), bindings);
}

function getObjectBoolean(obj, prop) {
  const node = getObjectProperty(obj, prop);
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function literalValue(node, constArrays = new Map()) {
  node = unwrapExpression(node);
  if (!node) return undefined;
  if (ts.isIdentifier(node) && constArrays.has(node.text)) {
    return literalValue(constArrays.get(node.text), constArrays);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    const values = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spreadValue = literalValue(element.expression, constArrays);
        if (!Array.isArray(spreadValue)) return undefined;
        values.push(...spreadValue);
        continue;
      }
      const value = literalValue(element, constArrays);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  return undefined;
}

function resolveConstArray(node, constArrays) {
  node = unwrapExpression(node);
  if (node && ts.isIdentifier(node)) return constArrays.get(node.text) ?? node;
  return node;
}

function getStringArray(obj, prop, constArrays = new Map()) {
  const value = literalValue(
    resolveConstArray(getObjectProperty(obj, prop), constArrays),
    constArrays,
  );
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

function getObjectArgs(obj, constArrays = new Map()) {
  const node = resolveConstArray(getObjectProperty(obj, "args"), constArrays);
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined;

  return argsFromArrayLiteral(node, constArrays);
}

function argsFromArrayLiteral(node, constArrays) {
  const args = [];
  for (const element of node.elements) {
    if (ts.isSpreadElement(element)) {
      const spreadNode = resolveConstArray(element.expression, constArrays);
      if (!spreadNode || !ts.isArrayLiteralExpression(spreadNode)) {
        return undefined;
      }
      const spreadArgs = argsFromArrayLiteral(spreadNode, constArrays);
      if (!spreadArgs) return undefined;
      args.push(...spreadArgs);
      continue;
    }
    const argNode = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(argNode)) return undefined;
    const name = getObjectString(argNode, "name");
    if (!name) return undefined;

    const arg = { name };
    const type = getObjectString(argNode, "type");
    if (type) arg.type = type;
    const defaultValue = literalValue(
      getObjectProperty(argNode, "default"),
      constArrays,
    );
    if (defaultValue !== undefined) arg.default = defaultValue;
    const required = getObjectBoolean(argNode, "required");
    if (required !== undefined) arg.required = required;
    const positional = getObjectBoolean(argNode, "positional");
    if (positional !== undefined) arg.positional = positional;
    const choices = getStringArray(argNode, "choices", constArrays);
    if (choices) arg.choices = choices;
    const description = getObjectString(argNode, "description");
    if (description) arg.description = description;
    const format = getObjectString(argNode, "format");
    if (format) arg.format = format;
    const kind = getObjectString(argNode, "x-unicli-kind");
    if (kind) arg["x-unicli-kind"] = kind;
    const accepts = getStringArray(argNode, "x-unicli-accepts", constArrays);
    if (accepts) arg["x-unicli-accepts"] = accepts;
    const uriOrigins = getStringArray(
      argNode,
      "x-unicli-uri-origins",
      constArrays,
    );
    if (uriOrigins) arg["x-unicli-uri-origins"] = uriOrigins;
    const uriPathPattern = getObjectString(
      argNode,
      "x-unicli-uri-path-pattern",
    );
    if (uriPathPattern) arg["x-unicli-uri-path-pattern"] = uriPathPattern;

    args.push(arg);
  }

  return args;
}

function collectLocalConstArrays(sf) {
  const constArrays = new Map();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        constArrays.set(declaration.name.text, initializer);
      }
    }
  }
  return constArrays;
}

function resolveRelativeTsImport(specifier, sourcePath) {
  if (!sourcePath || !specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(sourcePath), specifier);
  const candidates = [
    specifier.endsWith(".js") ? base.replace(/\.js$/, ".ts") : base,
    `${base}.ts`,
    resolve(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function collectConstArraysFromFile(filePath, seenPaths) {
  if (seenPaths.has(filePath)) return new Map();
  seenPaths.add(filePath);
  const source = readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const constArrays = collectImportedConstArrays(sf, filePath, seenPaths);
  for (const [name, node] of collectLocalConstArrays(sf)) {
    constArrays.set(name, node);
  }
  return constArrays;
}

function collectImportedConstArrays(sf, sourcePath, seenPaths) {
  const constArrays = new Map();
  if (!sourcePath) return constArrays;

  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const resolved = resolveRelativeTsImport(
      statement.moduleSpecifier.text,
      sourcePath,
    );
    if (!resolved) continue;
    const importClause = statement.importClause;
    const namedBindings = importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    const importedArrays = collectConstArraysFromFile(resolved, seenPaths);
    for (const [name, node] of importedArrays) {
      if (!constArrays.has(name)) constArrays.set(name, node);
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      const node = importedArrays.get(importedName);
      if (node) constArrays.set(localName, node);
    }
  }

  return constArrays;
}

function hasObjectProperty(obj, prop) {
  return getObjectProperty(obj, prop) !== undefined;
}

function makeAiChatCommands(site, displayName, hasModel, hasNew, adapterPath) {
  const suffix = displayName ? ` ${displayName}` : "";
  const metadata = commandMetadata(adapterPath);
  const commands = AI_CHAT_BASE_COMMANDS.map(([name, desc, args]) => ({
    name,
    description: `${desc}${suffix}`,
    strategy: "public",
    type: "web-api",
    ...metadata,
    ...(args
      ? {
          args: args.map((arg) =>
            name === "screenshot" && arg.name === "path"
              ? { ...arg, default: `./${site}-screenshot.png` }
              : arg,
          ),
        }
      : {}),
  }));
  if (hasModel) {
    commands.push({
      name: AI_CHAT_MODEL_COMMAND[0],
      description: `${AI_CHAT_MODEL_COMMAND[1]}${suffix}`,
      strategy: "public",
      type: "web-api",
      ...metadata,
      args: AI_CHAT_MODEL_COMMAND[2],
    });
  }
  if (hasNew) {
    commands.push({
      name: AI_CHAT_NEW_COMMAND[0],
      description: `${AI_CHAT_NEW_COMMAND[1]}${suffix}`,
      strategy: "public",
      type: "web-api",
      ...metadata,
    });
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}

export function extractTsRegistrations(
  source,
  fallbackSite,
  fallbackCommand,
  options = {},
) {
  const out = extractElectronDesktopRegistrations(
    source,
    fallbackSite,
    fallbackCommand,
  );
  const sf = ts.createSourceFile(
    `${fallbackSite}/${fallbackCommand}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const constArrays = collectImportedConstArrays(
    sf,
    options.sourcePath,
    new Set(options.sourcePath ? [options.sourcePath] : []),
  );
  for (const [name, node] of collectLocalConstArrays(sf)) {
    constArrays.set(name, node);
  }

  function stringLiteralArrayValues(node) {
    node = unwrapExpression(node);
    if (!node || !ts.isArrayLiteralExpression(node)) return undefined;
    const values = [];
    for (const element of node.elements) {
      const text = literalText(element);
      if (!text) return undefined;
      values.push(text);
    }
    return values;
  }

  function stringTupleArrayValues(node) {
    node = unwrapExpression(node);
    if (!node || !ts.isArrayLiteralExpression(node)) return undefined;
    const rows = [];
    for (const element of node.elements) {
      const tuple = unwrapExpression(element);
      if (!tuple || !ts.isArrayLiteralExpression(tuple)) return undefined;
      const values = [];
      for (const item of tuple.elements) {
        const text = literalText(item);
        if (!text) return undefined;
        values.push(text);
      }
      rows.push(values);
    }
    return rows;
  }

  function bindForOfValues(pattern, values, bindings) {
    const nextBindings = new Map(bindings);
    if (ts.isIdentifier(pattern)) {
      if (values.length !== 1) return undefined;
      nextBindings.set(pattern.text, values[0]);
      return nextBindings;
    }
    if (!ts.isArrayBindingPattern(pattern)) return undefined;

    for (let index = 0; index < pattern.elements.length; index++) {
      const element = pattern.elements[index];
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) {
        return undefined;
      }
      const value = values[index];
      if (!value) return undefined;
      nextBindings.set(element.name.text, value);
    }
    return nextBindings;
  }

  function visit(node, bindings = new Map()) {
    if (ts.isForOfStatement(node)) {
      const initializer = node.initializer;
      if (
        ts.isVariableDeclarationList(initializer) &&
        initializer.declarations.length === 1
      ) {
        const declaration = initializer.declarations[0];
        if (ts.isIdentifier(declaration.name)) {
          const values = stringLiteralArrayValues(node.expression);
          if (values) {
            for (const value of values) {
              const nextBindings = bindForOfValues(
                declaration.name,
                [value],
                bindings,
              );
              if (!nextBindings) continue;
              visit(node.statement, nextBindings);
            }
            return;
          }
        }
        if (ts.isArrayBindingPattern(declaration.name)) {
          const rows = stringTupleArrayValues(node.expression);
          if (rows) {
            for (const row of rows) {
              const nextBindings = bindForOfValues(
                declaration.name,
                row,
                bindings,
              );
              if (!nextBindings) continue;
              visit(node.statement, nextBindings);
            }
            return;
          }
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const first = node.arguments[0];
      const second = node.arguments[1];

      if (callee === "cli" && first && ts.isObjectLiteralExpression(first)) {
        const site = getObjectString(first, "site", bindings) || fallbackSite;
        const name = getObjectString(first, "name", bindings);
        if (!name) {
          ts.forEachChild(node, (child) => visit(child, bindings));
          return;
        }
        out.push({
          site,
          commands: [
            {
              name,
              description: getObjectString(first, "description", bindings),
              strategy: getObjectStrategy(first),
              type: "web-api",
              domain: getObjectString(first, "domain", bindings) || undefined,
              base: getObjectString(first, "base", bindings) || undefined,
              browser: getObjectBoolean(first, "browser"),
              columns: getStringArray(first, "columns", constArrays),
              defaultFormat:
                getObjectString(first, "defaultFormat", bindings) || undefined,
              capabilities: getStringArray(first, "capabilities", constArrays),
              auth_requirement:
                getObjectString(first, "auth_requirement", bindings) ||
                undefined,
              executables: getStringArray(first, "executables", constArrays),
              minimum_capability:
                getObjectString(first, "minimum_capability", bindings) ||
                undefined,
              args: getObjectArgs(first, constArrays),
              pipeline_steps: 0,
              adapter_path: `src/adapters/${fallbackSite}/${fallbackCommand}.ts`,
              target_surface:
                getObjectString(first, "target_surface", bindings) || undefined,
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
            site,
            displayName,
            options ? hasObjectProperty(options, "modelSelector") : false,
            options ? hasObjectProperty(options, "newChatSelector") : false,
            `src/adapters/${fallbackSite}/${fallbackCommand}.ts`,
          ),
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, bindings));
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
