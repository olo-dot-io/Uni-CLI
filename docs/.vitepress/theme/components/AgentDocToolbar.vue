<script setup lang="ts">
import { computed, ref } from "vue";
import { useData, useRoute, withBase } from "vitepress";
import pageIndex from "../../../page-index.json";

type PageIndexEntry = {
  title: string;
  routePath: string;
  markdownPath: string;
  section: string;
  parent: { text: string; link: string } | null;
  breadcrumbs: { text: string; link: string }[];
};

const route = useRoute();
const { site } = useData();
const copyState = ref<"idle" | "copied" | "error">("idle");

function normalizePath(path: string): string {
  let cleanPath = path.split("#")[0]?.split("?")[0] ?? "/";

  for (const base of [site.value.base, withBase("/")]) {
    if (base && base !== "/" && cleanPath.startsWith(base)) {
      cleanPath = cleanPath.slice(base.length - 1) || "/";
      break;
    }
  }

  const withoutHtml = cleanPath.replace(/\.html$/, "");

  if (withoutHtml === "/index") {
    return "/";
  }

  if (withoutHtml !== "/" && withoutHtml.endsWith("/index")) {
    return withoutHtml.slice(0, -"/index".length) || "/";
  }

  return withoutHtml || "/";
}

const pages = pageIndex.pages as PageIndexEntry[];

function findPage(path: string): PageIndexEntry | undefined {
  const normalizedPath = normalizePath(path);
  return pages.find((page) => normalizePath(page.routePath) === normalizedPath);
}

const currentPage = computed(() => {
  const routeMatch = findPage(route.path);
  if (routeMatch) {
    return routeMatch;
  }

  if (typeof window !== "undefined") {
    return findPage(window.location.pathname);
  }

  return undefined;
});

const markdownHref = computed(() =>
  currentPage.value ? withBase(currentPage.value.markdownPath) : "",
);

async function copyMarkdown() {
  const page = currentPage.value;
  if (!page) {
    return;
  }

  copyState.value = "idle";

  try {
    const response = await fetch(markdownHref.value);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await navigator.clipboard.writeText(await response.text());
    copyState.value = "copied";
    window.setTimeout(() => {
      copyState.value = "idle";
    }, 1800);
  } catch {
    copyState.value = "error";
  }
}
</script>

<template>
  <nav
    v-if="currentPage"
    class="agent-doc-toolbar"
    aria-label="Page hierarchy and agent actions"
  >
    <div class="agent-doc-path">
      <a
        v-if="currentPage.parent"
        class="agent-back-link"
        :href="withBase(currentPage.parent.link)"
      >
        Back to {{ currentPage.parent.text }}
      </a>
      <span v-else class="agent-section-label">{{ currentPage.section }}</span>

      <ol class="agent-breadcrumbs">
        <li v-for="crumb in currentPage.breadcrumbs" :key="crumb.link">
          <a :href="withBase(crumb.link)">{{ crumb.text }}</a>
        </li>
        <li aria-current="page">{{ currentPage.title }}</li>
      </ol>
    </div>

    <div class="agent-doc-actions" aria-label="Markdown actions">
      <button type="button" class="agent-copy-button" @click="copyMarkdown">
        {{
          copyState === "copied"
            ? "Copied"
            : copyState === "error"
              ? "Copy failed"
              : "Copy Markdown"
        }}
      </button>
      <a
        class="agent-markdown-link"
        :href="markdownHref"
        target="_self"
        type="text/markdown"
      >
        Open .md
      </a>
    </div>
  </nav>
</template>
