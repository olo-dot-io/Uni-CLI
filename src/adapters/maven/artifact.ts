/**
 * @owner   src/adapters/maven/artifact.ts
 * @does    Register agent-facing Maven Central artifact version history command.
 * @needs   search.maven.org Solr gav core and coordinate validation.
 * @feeds   surface coverage ledger, JVM dependency inspection, registry command surface.
 * @breaks  Maven coordinate parsing or Solr envelope drift hides dependency versions.
 */

import { cli, Strategy } from "../../registry.js";

const MAVEN_BASE = "https://search.maven.org/solrsearch/select";

interface MavenDoc {
  g?: unknown;
  a?: unknown;
  v?: unknown;
  p?: unknown;
  timestamp?: unknown;
  tags?: unknown;
}

interface MavenBody {
  response?: { docs?: MavenDoc[] };
}

export interface MavenCoordinate {
  groupId: string;
  artifactId: string;
  version: string;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function epochMsToIso(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : "";
}

export function requireMavenLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(
      `limit must be an integer in [1, 200]. Got: ${String(value)}`,
    );
  }
  return n;
}

export function parseMavenCoordinate(value: unknown): MavenCoordinate {
  const coordinate = String(value ?? "").trim();
  const parts = coordinate.split(":").map((part) => part.trim());
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(
      'coordinate must be "groupId:artifactId" or "groupId:artifactId:version".',
    );
  }
  const [groupId, artifactId, version = ""] = parts;
  if (!groupId || !artifactId) {
    throw new Error("coordinate groupId and artifactId are required.");
  }
  return { groupId, artifactId, version };
}

export function mapMavenArtifactRows(
  body: MavenBody,
  coordinate: MavenCoordinate,
): Array<Record<string, unknown>> {
  const docs = Array.isArray(body.response?.docs) ? body.response.docs : [];
  if (docs.length === 0) {
    const label = coordinate.version
      ? `${coordinate.groupId}:${coordinate.artifactId}:${coordinate.version}`
      : `${coordinate.groupId}:${coordinate.artifactId}`;
    throw new Error(`Maven Central has no published versions for ${label}.`);
  }
  return docs.map((doc) => {
    const version = stringField(doc.v);
    return {
      groupId: stringField(doc.g) || coordinate.groupId,
      artifactId: stringField(doc.a) || coordinate.artifactId,
      version,
      packaging: stringField(doc.p),
      publishedAt: epochMsToIso(doc.timestamp),
      tags: Array.isArray(doc.tags)
        ? doc.tags.map(stringField).filter(Boolean).join(", ")
        : "",
      url: version
        ? `https://central.sonatype.com/artifact/${coordinate.groupId}/${coordinate.artifactId}/${version}`
        : `https://central.sonatype.com/artifact/${coordinate.groupId}/${coordinate.artifactId}`,
    };
  });
}

async function fetchMavenJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "unicli (https://github.com/olo-dot-io/Uni-CLI)",
      Accept: "application/json",
    },
  });
  if (!response.ok)
    throw new Error(`maven artifact returned HTTP ${response.status}.`);
  return response.json();
}

cli({
  site: "maven",
  name: "artifact",
  description: "Fetch Maven Central artifact version history",
  domain: "search.maven.org",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "coordinate",
      type: "str",
      required: true,
      positional: true,
      description: 'Maven coordinate "groupId:artifactId[:version]"',
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Max versions",
    },
  ],
  columns: [
    "groupId",
    "artifactId",
    "version",
    "packaging",
    "publishedAt",
    "tags",
    "url",
  ],
  func: async (_page, kwargs) => {
    const coordinate = parseMavenCoordinate(kwargs.coordinate);
    const limit = requireMavenLimit(kwargs.limit, 20);
    const filters = [`g:${coordinate.groupId}`, `a:${coordinate.artifactId}`];
    if (coordinate.version) filters.push(`v:${coordinate.version}`);
    const params = new URLSearchParams({
      q: filters.join(" AND "),
      core: "gav",
      rows: String(coordinate.version ? 1 : limit),
      wt: "json",
    });
    const body = (await fetchMavenJson(
      `${MAVEN_BASE}?${params.toString()}`,
    )) as MavenBody;
    return mapMavenArtifactRows(body, coordinate);
  },
});
