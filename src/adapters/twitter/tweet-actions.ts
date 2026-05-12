/**
 * @owner   src/adapters/twitter/tweet-actions.ts
 * @does    Register agent-facing Twitter unlike, retweet, and unretweet URL actions.
 * @needs   Browser session on x.com, exact tweet URL parsing, scoped article action buttons.
 * @feeds   surface coverage ledger, Twitter write-action workflows, safe tweet-level UI actions.
 * @breaks  X DOM test-id drift or weak tweet scoping can act on the wrong tweet.
 */

import { cli, Strategy } from "../../registry.js";
import type { AdapterArg } from "../../types.js";
import {
  buildTwitterArticleScopeSource,
  parseTwitterTweetUrl,
} from "./tweet-url.js";

export { buildTwitterArticleScopeSource, parseTwitterTweetUrl };

type ToggleAction = "unlike" | "retweet" | "unretweet";

const ACTIONS: Record<
  ToggleAction,
  {
    activeTestId: string;
    inactiveTestId: string;
    confirmTestId: string;
    alreadyMessage: string;
    successMessage: string;
    missingMessage: string;
    mismatchMessage: string;
    needsConfirm: boolean;
  }
> = {
  unlike: {
    activeTestId: "unlike",
    inactiveTestId: "like",
    confirmTestId: "",
    alreadyMessage: "Tweet is not liked (already unliked).",
    successMessage: "Tweet successfully unliked.",
    missingMessage:
      "Could not find the Unlike button on this tweet. Are you logged in?",
    mismatchMessage:
      "Unlike action was initiated but UI did not update as expected.",
    needsConfirm: false,
  },
  retweet: {
    activeTestId: "retweet",
    inactiveTestId: "unretweet",
    confirmTestId: "retweetConfirm",
    alreadyMessage: "Tweet is already retweeted.",
    successMessage: "Tweet successfully retweeted.",
    missingMessage:
      "Could not find the Retweet button on this tweet. Are you logged in?",
    mismatchMessage:
      "Retweet action was initiated but UI did not update as expected.",
    needsConfirm: true,
  },
  unretweet: {
    activeTestId: "unretweet",
    inactiveTestId: "retweet",
    confirmTestId: "unretweetConfirm",
    alreadyMessage: "Tweet is not retweeted (already removed).",
    successMessage: "Tweet successfully unretweeted.",
    missingMessage:
      "Could not find the Unretweet button on this tweet. Are you logged in?",
    mismatchMessage:
      "Unretweet action was initiated but UI did not update as expected.",
    needsConfirm: true,
  },
};

export function buildTweetToggleScript(
  action: ToggleAction,
  tweetId: string,
): string {
  const config = ACTIONS[action];
  return `(async () => {
    try {
      ${buildTwitterArticleScopeSource(tweetId)}
      let targetArticle = null;
      let activeButton = null;
      let inactiveButton = null;
      for (let i = 0; i < 20; i++) {
        targetArticle = findTargetArticle();
        activeButton = targetArticle?.querySelector('[data-testid="${config.activeTestId}"]') || null;
        inactiveButton = targetArticle?.querySelector('[data-testid="${config.inactiveTestId}"]') || null;
        if (activeButton || inactiveButton) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (inactiveButton) return { ok: true, message: ${JSON.stringify(config.alreadyMessage)} };
      if (!activeButton) return { ok: false, message: ${JSON.stringify(config.missingMessage)} };
      activeButton.click();
      ${
        config.needsConfirm
          ? `
      let confirmButton = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        confirmButton = document.querySelector('[data-testid="${config.confirmTestId}"]');
        if (confirmButton) break;
      }
      if (!confirmButton) return { ok: false, message: 'Confirmation menu item did not appear.' };
      confirmButton.click();
      `
          : ""
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const verifyArticle = findTargetArticle() || targetArticle;
      const verifyButton = verifyArticle?.querySelector('[data-testid="${config.inactiveTestId}"]');
      if (verifyButton) return { ok: true, message: ${JSON.stringify(config.successMessage)} };
      return { ok: false, message: ${JSON.stringify(config.mismatchMessage)} };
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  })()`;
}

function tweetActionFunc(action: ToggleAction) {
  return async (page: unknown, kwargs: Record<string, unknown>) => {
    if (!page || typeof page !== "object") {
      throw new Error(`Browser session required for twitter ${action}.`);
    }
    const target = parseTwitterTweetUrl(kwargs.url);
    const browserPage = page as {
      goto: (url: string) => Promise<unknown>;
      wait: (args: unknown) => Promise<unknown>;
      evaluate: (script: string) => Promise<{ ok?: boolean; message?: string }>;
    };
    await browserPage.goto(target.url);
    await browserPage.wait({ selector: '[data-testid="primaryColumn"]' });
    const result = await browserPage.evaluate(
      buildTweetToggleScript(action, target.id),
    );
    if (result.ok) await browserPage.wait(2);
    return [
      {
        status: result.ok ? "success" : "failed",
        message: result.message || "",
      },
    ];
  };
}

const tweetUrlArg: AdapterArg[] = [
  {
    name: "url",
    type: "str",
    required: true,
    positional: true,
    description: "Tweet URL",
  },
];

cli({
  site: "twitter",
  name: "unlike",
  description: "Twitter unlike a specific tweet",
  domain: "x.com",
  strategy: Strategy.UI,
  browser: true,
  args: tweetUrlArg,
  columns: ["status", "message"],
  func: tweetActionFunc("unlike"),
});

cli({
  site: "twitter",
  name: "retweet",
  description: "Twitter retweet a specific tweet",
  domain: "x.com",
  strategy: Strategy.UI,
  browser: true,
  args: tweetUrlArg,
  columns: ["status", "message"],
  func: tweetActionFunc("retweet"),
});

cli({
  site: "twitter",
  name: "unretweet",
  description: "Twitter unretweet a specific tweet",
  domain: "x.com",
  strategy: Strategy.UI,
  browser: true,
  args: tweetUrlArg,
  columns: ["status", "message"],
  func: tweetActionFunc("unretweet"),
});
