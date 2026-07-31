/**
 * @owner       src::core::operation-family
 * @does        Resolve and infer the semantic verb family of an intent or command independently from its execution substrate.
 * @needs       command name, description, optional retrieval metadata, and explicit operation-family declarations
 * @feeds       command contracts and discovery feasibility
 * @breaks      Conflating action semantics with provider ranking can turn a requested search into an unrelated list/read operation.
 * @invariants  Explicit declarations outrank names; exact command-name verbs outrank description heuristics; unknown is represented rather than guessed.
 * @side-effects None.
 * @perf        O(command-name + description length) with bounded regular expressions.
 * @concurrency Pure.
 * @test        tests/unit/discovery-feasibility.test.ts, tests/unit/commands/do.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

import type { OperationFamily, RetrievalMetadata } from "../types.js";

export interface OperationFamilyProfile {
  family: OperationFamily;
  source: "declared" | "command_name" | "retrieval" | "description" | "unknown";
  confidence: "high" | "medium" | "low";
}

export interface ResolveOperationFamilyInput {
  command: string;
  description?: string;
  retrieval?: RetrievalMetadata;
  explicit?: OperationFamily;
}

export function resolveOperationFamily(
  input: ResolveOperationFamilyInput,
): OperationFamilyProfile {
  if (input.explicit) {
    return { family: input.explicit, source: "declared", confidence: "high" };
  }
  const fromName = familyFromCommandName(input.command);
  if (fromName) {
    return { family: fromName, source: "command_name", confidence: "high" };
  }
  const fromDescription = familyFromText(input.description ?? "");
  if (fromDescription) {
    return {
      family: fromDescription,
      source: "description",
      confidence: "medium",
    };
  }
  if (input.retrieval?.operation === "discover") {
    return { family: "search", source: "retrieval", confidence: "low" };
  }
  return { family: "unknown", source: "unknown", confidence: "low" };
}

export function inferIntentOperationFamily(
  intent: string,
): OperationFamily | undefined {
  const text = intent.normalize("NFKC").toLowerCase();
  // Strong domain nouns such as top/trending/feed describe list operations
  // even when an English request uses the generic verb "get".
  if (
    /\b(top stories?|trending|hot topics?|latest (?:posts?|items?|stories?|news)|feed)\b/.test(
      text,
    ) ||
    /热门|热榜|趋势|最新(?:帖子|内容|新闻)|信息流/.test(text)
  ) {
    return "list";
  }
  const englishVerb = leadingEnglishVerb(text);
  if (englishVerb) return familyForVerb(englishVerb);
  const chineseVerb = text
    .replace(/^(?:请|麻烦|帮我|请帮我)\s*/u, "")
    .match(
      /^(搜索|检索|查找|查询|推荐|截图|捕获|下载|导出|删除|移除|销毁|更新|编辑|修改|重命名|设置|创建|发布|发送|新增|上传|登录|认证|打开|访问|导航|点击|轻触|按下|输入|滚动|拖动|播放|运行|执行|列出|展示|浏览|获取|读取|查看|检查)/u,
    )?.[1];
  return chineseVerb ? familyForVerb(chineseVerb) : undefined;
}

function leadingEnglishVerb(text: string): string | undefined {
  const verb =
    "search|find|query|lookup|recommend|screenshot|capture|download|export|save|delete|remove|destroy|update|edit|modify|rename|set|create|publish|post|send|add|upload|login|authenticate|open|navigate|visit|click|tap|press|type|scroll|drag|play|run|execute|list|show|browse|get|read|fetch|inspect|view";
  const normalized = text.replace(
    /^(?:please\s+|kindly\s+|can you\s+|could you\s+|would you\s+|i (?:want|need) (?:you )?to\s+)/,
    "",
  );
  return (
    normalized.match(new RegExp(`^(${verb})\\b`))?.[1] ??
    text.match(new RegExp(`\\b(?:want|need|ask) (?:you )?to (${verb})\\b`))?.[1]
  );
}

function familyForVerb(verb: string): OperationFamily {
  if (
    [
      "search",
      "find",
      "query",
      "lookup",
      "搜索",
      "检索",
      "查找",
      "查询",
    ].includes(verb)
  )
    return "search";
  if (["screenshot", "capture", "截图", "捕获"].includes(verb))
    return "capture";
  if (["download", "export", "save", "下载", "导出"].includes(verb))
    return "download";
  if (["delete", "remove", "destroy", "删除", "移除", "销毁"].includes(verb))
    return "delete";
  if (
    [
      "update",
      "edit",
      "modify",
      "rename",
      "set",
      "更新",
      "编辑",
      "修改",
      "重命名",
      "设置",
    ].includes(verb)
  )
    return "update";
  if (
    [
      "create",
      "publish",
      "post",
      "send",
      "add",
      "upload",
      "创建",
      "发布",
      "发送",
      "新增",
      "上传",
    ].includes(verb)
  )
    return "create";
  if (["login", "authenticate", "登录", "认证"].includes(verb))
    return "authenticate";
  if (["open", "navigate", "visit", "打开", "访问", "导航"].includes(verb))
    return "navigate";
  if (
    [
      "click",
      "tap",
      "press",
      "type",
      "scroll",
      "drag",
      "play",
      "run",
      "execute",
      "点击",
      "轻触",
      "按下",
      "输入",
      "滚动",
      "拖动",
      "播放",
      "运行",
      "执行",
    ].includes(verb)
  )
    return "invoke";
  if (
    [
      "recommend",
      "list",
      "show",
      "browse",
      "推荐",
      "列出",
      "展示",
      "浏览",
    ].includes(verb)
  )
    return "list";
  return "get";
}

function familyFromCommandName(command: string): OperationFamily | undefined {
  const token = command.normalize("NFKC").toLowerCase().split(/[-_]/)[0] ?? "";
  if (["search", "find", "query", "lookup", "discover"].includes(token))
    return "search";
  if (["get", "read", "fetch", "inspect", "view", "show"].includes(token))
    return "get";
  if (
    [
      "list",
      "top",
      "hot",
      "best",
      "new",
      "latest",
      "trending",
      "feed",
      "sources",
      "profiles",
      "landscape",
      "recommend",
      "recommendations",
    ].includes(token)
  )
    return "list";
  if (
    ["create", "add", "post", "publish", "send", "upload", "invite"].includes(
      token,
    )
  )
    return "create";
  if (
    ["update", "edit", "modify", "rename", "set", "toggle", "mark"].includes(
      token,
    )
  )
    return "update";
  if (["delete", "remove", "destroy", "clear"].includes(token)) return "delete";
  if (["screenshot", "capture", "snapshot", "observe"].includes(token))
    return "capture";
  if (["open", "navigate", "visit", "goto"].includes(token)) return "navigate";
  if (["download", "export", "save"].includes(token)) return "download";
  if (["login", "auth", "authenticate", "signin"].includes(token))
    return "authenticate";
  if (
    [
      "click",
      "tap",
      "press",
      "type",
      "scroll",
      "drag",
      "run",
      "execute",
      "launch",
      "play",
      "start",
      "stop",
    ].includes(token)
  )
    return "invoke";
  return undefined;
}

function familyFromText(description: string): OperationFamily | undefined {
  return inferIntentOperationFamily(description);
}
