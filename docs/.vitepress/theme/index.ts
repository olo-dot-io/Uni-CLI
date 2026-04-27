import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Layout from "./components/Layout.vue";
import SiteCatalog from "./components/SiteCatalog.vue";
import SiteStats from "./components/SiteStats.vue";
import VersionNotice from "./components/VersionNotice.vue";
import { installPretextTypography } from "./pretext-typography";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("SiteCatalog", SiteCatalog);
    app.component("SiteStats", SiteStats);
    app.component("VersionNotice", VersionNotice);
    installPretextTypography();
  },
} satisfies Theme;
