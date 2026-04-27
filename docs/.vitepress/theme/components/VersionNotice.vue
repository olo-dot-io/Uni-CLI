<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";
import releaseInfo from "../../../release-info.json";
import siteIndex from "../../../site-index.json";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");
const highlights = computed(() =>
  isZh.value ? releaseInfo.highlights.zh : releaseInfo.highlights.root,
);
const catalogLabel = computed(() =>
  isZh.value
    ? `${siteIndex.total_sites} 个站点 / ${siteIndex.total_commands} 条命令`
    : `${siteIndex.total_sites} sites / ${siteIndex.total_commands} commands`,
);
</script>

<template>
  <section
    class="uni-version-notice"
    :aria-labelledby="isZh ? 'uni-version-title-zh' : 'uni-version-title'"
  >
    <div class="uni-version-inner">
      <div class="uni-version-copy">
        <p class="uni-eyebrow">
          {{ isZh ? "当前版本" : "Current Version" }}
        </p>
        <h2 :id="isZh ? 'uni-version-title-zh' : 'uni-version-title'">
          {{
            isZh
              ? `v${releaseInfo.version} 已发布到 npm。`
              : `v${releaseInfo.version} is live on npm.`
          }}
        </h2>
        <p>
          {{
            isZh
              ? `${releaseInfo.codename} 于 ${releaseInfo.date} 发布，npm 包 ${releaseInfo.npmPackage} 当前 latest 指向这个版本。`
              : `${releaseInfo.codename} shipped on ${releaseInfo.date}; the ${releaseInfo.npmPackage} npm latest tag now points to this release.`
          }}
        </p>
      </div>

      <div class="uni-version-meta">
        <dl>
          <div>
            <dt>{{ isZh ? "版本" : "Version" }}</dt>
            <dd>v{{ releaseInfo.version }}</dd>
          </div>
          <div>
            <dt>{{ isZh ? "规模" : "Catalog" }}</dt>
            <dd>{{ catalogLabel }}</dd>
          </div>
          <div>
            <dt>{{ isZh ? "包名" : "Package" }}</dt>
            <dd>{{ releaseInfo.npmPackage }}</dd>
          </div>
        </dl>
        <div class="uni-version-actions">
          <a
            :href="releaseInfo.npmUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ isZh ? "打开 npm 包" : "Open npm Package" }}
          </a>
          <a
            :href="releaseInfo.releaseUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ isZh ? "查看 GitHub Release" : "View GitHub Release" }}
          </a>
          <a
            :href="releaseInfo.changelogUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ isZh ? "查看 Changelog" : "Read Changelog" }}
          </a>
        </div>
      </div>

      <ul class="uni-version-highlights">
        <li v-for="highlight in highlights" :key="highlight">
          {{ highlight }}
        </li>
      </ul>
    </div>
  </section>
</template>
