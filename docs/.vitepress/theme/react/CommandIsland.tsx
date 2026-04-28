import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tabs } from "@base-ui/react/tabs";

type Locale = "root" | "zh";

type CommandIslandProps = {
  locale: Locale;
};

type Step = {
  value: string;
  label: string;
  title: string;
  body: string;
  command: string;
  details: { name: string; value: string }[];
};

const copy: Record<
  Locale,
  {
    tabsLabel: string;
    commandLabel: string;
    detailsLabel: string;
    copy: string;
    copied: string;
    steps: Step[];
  }
> = {
  root: {
    tabsLabel: "Command lifecycle",
    commandLabel: "Command",
    detailsLabel: "What stays inspectable",
    copy: "Copy",
    copied: "Copied",
    steps: [
      {
        value: "discover",
        label: "01 Discover",
        title: "Search selects a command with the action still visible.",
        body: "The catalog can be broad because execution stays explicit and keeps inputs visible.",
        command: 'unicli search "hacker news frontpage"',
        details: [
          { name: "ranked result", value: "site, command, summary, examples" },
          { name: "execution shape", value: "args schema, auth, surface type" },
          { name: "side effect", value: "none: discovery only" },
        ],
      },
      {
        value: "execute",
        label: "02 Execute",
        title: "Execution returns one stable envelope.",
        body: "The same command can render Markdown for review or JSON/YAML/CSV for programs without changing the underlying result shape.",
        command: "unicli hackernews top --limit 5 -f json",
        details: [
          { name: "success", value: "ok, schema_version, data, meta" },
          { name: "empty result", value: "exit 66 with a structured response" },
          { name: "machine path", value: "-f json for scripts and agents" },
        ],
      },
      {
        value: "repair",
        label: "03 Repair",
        title: "A broken surface becomes a patch target.",
        body: "Failures include the adapter path, step, retryability, suggestion, and alternatives so repair starts from the smallest file diff.",
        command: "unicli repair hackernews top",
        details: [
          { name: "where", value: "error.adapter_path and error.step" },
          { name: "what next", value: "suggestion, retryable, alternatives" },
          { name: "verify", value: "repair command plus the original command" },
        ],
      },
    ],
  },
  zh: {
    tabsLabel: "命令生命周期",
    commandLabel: "命令",
    detailsLabel: "Agent 能检查什么",
    copy: "复制",
    copied: "已复制",
    steps: [
      {
        value: "discover",
        label: "01 发现",
        title: "搜索只选命令，不把动作藏起来。",
        body: "目录可以很宽，执行仍然是另一条明确命令。Agent 先看到输入和边界，再决定要不要跑。",
        command: 'unicli search "hacker news frontpage"',
        details: [
          { name: "排序结果", value: "站点、命令、摘要、样例" },
          { name: "执行形状", value: "参数 schema、认证、接口类型" },
          { name: "副作用", value: "发现阶段只读目录" },
        ],
      },
      {
        value: "execute",
        label: "02 执行",
        title: "执行返回统一 envelope，结果形状稳定。",
        body: "同一条命令可以渲染成 Markdown 给人审阅，也可以输出 JSON/YAML/CSV 给程序消费，底层结果形状不变。",
        command: "unicli hackernews top --limit 5 -f json",
        details: [
          { name: "成功", value: "ok、schema_version、data、meta" },
          { name: "空结果", value: "退出码 66，仍然有结构化响应" },
          { name: "机器消费", value: "脚本和 Agent 使用 -f json" },
        ],
      },
      {
        value: "repair",
        label: "03 修复",
        title: "外部界面变了，错误要落到具体 patch 目标。",
        body: "失败会带上 adapter 路径、pipeline step、是否可重试、建议和替代命令。修复从最小文件 diff 开始。",
        command: "unicli repair hackernews top",
        details: [
          { name: "位置", value: "error.adapter_path 和 error.step" },
          { name: "下一步", value: "suggestion、retryable、alternatives" },
          { name: "验证", value: "repair 命令加原命令回归" },
        ],
      },
    ],
  },
};

function CommandIsland({ locale }: CommandIslandProps) {
  const text = copy[locale];
  const [copied, setCopied] = React.useState<string | null>(null);

  async function copyCommand(step: Step) {
    if (!navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(step.command);
    } catch {
      return;
    }
    setCopied(step.value);
    window.setTimeout(() => {
      setCopied(null);
    }, 1600);
  }

  return (
    <Tabs.Root className="uni-command-ledger" defaultValue="discover">
      <Tabs.List className="uni-command-tab-list" aria-label={text.tabsLabel}>
        {text.steps.map((step) => (
          <Tabs.Tab
            key={step.value}
            className="uni-command-tab"
            value={step.value}
          >
            {step.label}
          </Tabs.Tab>
        ))}
        <Tabs.Indicator className="uni-command-tab-indicator" />
      </Tabs.List>

      {text.steps.map((step) => (
        <Tabs.Panel
          key={step.value}
          className="uni-command-panel"
          value={step.value}
        >
          <div className="uni-command-panel-copy">
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </div>

          <div className="uni-command-detail">
            <div className="uni-command-row">
              <span>{text.commandLabel}</span>
              <div>
                <code>{step.command}</code>
                <button type="button" onClick={() => void copyCommand(step)}>
                  {copied === step.value ? text.copied : text.copy}
                </button>
              </div>
            </div>
            <div className="uni-command-facts">
              <span>{text.detailsLabel}</span>
              <dl>
                {step.details.map((detail) => (
                  <div key={detail.name}>
                    <dt>{detail.name}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

export function mountCommandIsland(
  element: HTMLElement,
  props: CommandIslandProps,
) {
  const root: Root = createRoot(element);
  root.render(
    <React.StrictMode>
      <CommandIsland {...props} />
    </React.StrictMode>,
  );

  return () => {
    root.unmount();
  };
}
