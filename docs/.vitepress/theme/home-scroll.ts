import type { InjectionKey } from "vue";

export type HomeScrollTo = (top: number) => void;

export const homeScrollToKey: InjectionKey<HomeScrollTo> =
  Symbol("uni-home-scroll-to");
