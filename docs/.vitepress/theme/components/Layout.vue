<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import AgentDocToolbar from "./AgentDocToolbar.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #doc-before>
      <AgentDocToolbar />
    </template>
    <template #home-hero-before>
      <AgentDocToolbar />
    </template>
  </Layout>
</template>
