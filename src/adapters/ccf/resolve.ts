/**
 * Pure CCF conference identity resolution shared by publisher adapters.
 * This module deliberately has no registry side effects.
 */

import {
  CCF_A_CONFERENCES,
  type CcfConferenceRecord,
} from "./directory-data.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalize(value: unknown): string {
  return text(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, " ")
    .trim();
}

function compact(value: unknown): string {
  return normalize(value).replace(/\s+/g, "");
}

function publisherMatches(
  record: CcfConferenceRecord,
  publisher: string | undefined,
): boolean {
  return (
    !publisher || normalize(record.publisher).includes(normalize(publisher))
  );
}

const COMMON_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ASE: ["Automated Software Engineering"],
  FSE: ["Foundations of Software Engineering"],
  "S&P": ["Oakland", "IEEE Oakland"],
  SIGMOD: ["Management of Data", "ACM Management of Data"],
  SIGCOMM: ["ACM SIGCOMM", "ACM SIGCOMM Conference"],
  VLDB: ["PVLDB", "Proceedings of the VLDB Endowment"],
  WWW: ["ACM Web Conference", "World Wide Web Conference"],
};

export function ccfConferenceIdentities(record: CcfConferenceRecord): string[] {
  return [
    record.acronym,
    record.name,
    ...record.aliases,
    ...(COMMON_ALIASES[record.acronym] ?? []),
  ];
}

const CONFERENCE_QUERY_CONTEXT_WORDS = new Set([
  "a",
  "acm",
  "an",
  "and",
  "conference",
  "for",
  "ieee",
  "in",
  "issue",
  "journal",
  "lncs",
  "main",
  "of",
  "official",
  "on",
  "pacmmod",
  "pacmpl",
  "pacmse",
  "paper",
  "papers",
  "proceedings",
  "publication",
  "publications",
  "siam",
  "springer",
  "technical",
  "the",
  "to",
  "track",
  "verlag",
  "volume",
]);

export function ccfResidualSearchQuery(
  value: unknown,
  record: CcfConferenceRecord,
): string | undefined {
  const identityTokens = new Set<string>();
  for (const identity of [
    ...ccfConferenceIdentities(record),
    record.publisher,
  ]) {
    const words = normalize(identity).split(" ").filter(Boolean);
    for (const word of words) identityTokens.add(word);
    const compactIdentity = compact(identity);
    if (compactIdentity) identityTokens.add(compactIdentity);
  }
  const residual = text(value)
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .split(/\s+/)
    .map((word) => compact(word))
    .filter(
      (word) =>
        word.length > 0 &&
        !identityTokens.has(word) &&
        !CONFERENCE_QUERY_CONTEXT_WORDS.has(word),
    )
    .join(" ");
  return residual || undefined;
}

const CROSSREF_CONTAINER_QUERIES: Readonly<Record<string, string>> = {
  DAC: "Design Automation Conference",
  MICRO: "Microarchitecture",
  SIGMOD: "Management of Data",
  SIGCOMM: "ACM SIGCOMM",
  VLDB: "Proceedings of the VLDB Endowment",
  "IEEE VIS": "Visualization",
  WWW: "ACM Web Conference",
};

export function ccfCrossrefContainerQuery(record: CcfConferenceRecord): string {
  return CROSSREF_CONTAINER_QUERIES[record.acronym] ?? record.name;
}

export function resolveCcfConference(
  value: unknown,
  publisher?: string,
): CcfConferenceRecord | undefined {
  const target = compact(value);
  if (!target) return undefined;
  return CCF_A_CONFERENCES.find(
    (record) =>
      publisherMatches(record, publisher) &&
      ccfConferenceIdentities(record).map(compact).includes(target),
  );
}

export function findCcfConferenceInText(
  value: unknown,
  publisher?: string,
): CcfConferenceRecord | undefined {
  const source = text(value);
  if (!source) return undefined;
  const normalizedSource = ` ${normalize(source)} `;
  const candidates = CCF_A_CONFERENCES.filter((record) =>
    publisherMatches(record, publisher),
  ).sort((left, right) => right.name.length - left.name.length);
  for (const record of candidates) {
    const identities = ccfConferenceIdentities(record).filter(Boolean);
    if (
      identities.some((identity) =>
        normalizedSource.includes(` ${normalize(identity)} `),
      )
    ) {
      return record;
    }
    const acronym = record.acronym;
    const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = acronym.length <= 2 ? "" : "i";
    if (
      new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, flags).test(
        source,
      )
    ) {
      return record;
    }
  }
  return undefined;
}
