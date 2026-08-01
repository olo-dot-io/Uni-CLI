<!--
@owner docs/.vitepress/theme/components/OperationReceipt.vue
@does Show one concrete intent-to-operation selection and its structured receipt.
@needs VitePress locale data
@feeds English and Chinese documentation homepages
@breaks A fictional or ambiguous route would misrepresent the operation contract.
@invariants One registry operation is selected; the ranked alternatives and live-verified receipt remain factual.
@side-effects None.
@perf O(1) static bilingual content per render.
@concurrency Render-only Vue component.
@test npm run docs:build verifies the compiled public surface
@stability stable
@since 2026-08-01
-->
<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";
import homeOperation from "../../../home-operation.json";

const { localeIndex } = useData();
const isZh = computed(() => localeIndex.value === "zh");

const copy = computed(() =>
  isZh.value
    ? {
        intentLabel: "INTENT",
        intent: homeOperation.intent.zh,
        candidatesLabel: "CANDIDATES",
        selected: "已选择",
        ranked: "候选",
        candidates: homeOperation.candidates.zh,
        receiptLabel: "RECEIPT",
        fields: Object.entries(homeOperation.selected),
        result: homeOperation.result.zh,
      }
    : {
        intentLabel: "INTENT",
        intent: homeOperation.intent.en,
        candidatesLabel: "CANDIDATES",
        selected: "Selected",
        ranked: "Ranked",
        candidates: homeOperation.candidates.en,
        receiptLabel: "RECEIPT",
        fields: Object.entries(homeOperation.selected),
        result: homeOperation.result.en,
      },
);

function statusLabel(index: number): string {
  return index === 0 ? copy.value.selected : copy.value.ranked;
}
</script>

<template>
  <div class="uni-operation-receipt">
    <div class="uni-receipt-intent">
      <span>{{ copy.intentLabel }}</span>
      <strong>{{ copy.intent }}</strong>
      <code>unicli search "{{ copy.intent }}"</code>
    </div>

    <div class="uni-receipt-candidates">
      <span>{{ copy.candidatesLabel }}</span>
      <ol>
        <li
          v-for="(candidate, index) in copy.candidates"
          :key="candidate"
          :class="{ 'is-selected': index === 0 }"
        >
          <i aria-hidden="true" />
          <strong>{{ candidate }}</strong>
          <code
            >{{ homeOperation.selected.operator }} ·
            {{ homeOperation.selected.effect }}</code
          >
          <b>{{ statusLabel(index) }}</b>
        </li>
      </ol>
    </div>

    <div class="uni-receipt-result">
      <span>{{ copy.receiptLabel }}</span>
      <dl>
        <div v-for="field in copy.fields" :key="field[0]">
          <dt>{{ field[0] }}</dt>
          <dd>{{ field[1] }}</dd>
        </div>
      </dl>
      <p><i aria-hidden="true" />{{ copy.result }}</p>
    </div>
  </div>
</template>
