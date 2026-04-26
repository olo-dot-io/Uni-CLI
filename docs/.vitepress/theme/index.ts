import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Layout from "./components/Layout.vue";
import SiteCatalog from "./components/SiteCatalog.vue";
import SiteStats from "./components/SiteStats.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("SiteCatalog", SiteCatalog);
    app.component("SiteStats", SiteStats);
  },
} satisfies Theme;
