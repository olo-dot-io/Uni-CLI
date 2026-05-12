/**
 * @owner   src/adapters/instagram/collections.ts
 * @does    Register agent-facing Instagram saved collection create and delete commands.
 * @needs   Logged-in www.instagram.com browser session with csrftoken cookie.
 * @feeds   surface coverage ledger and saved-post collection management workflows.
 * @breaks  Instagram private collection API changes, CSRF cookie changes, or collection list schema drift.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";

interface InstagramCollectionResult {
  ok?: unknown;
  error?: unknown;
  row?: unknown;
}

interface InstagramCollectionRow {
  status?: unknown;
  collectionId?: unknown;
  collectionName?: unknown;
  mediaCount?: unknown;
}

export function requireInstagramCollectionInput(
  value: unknown,
  label: string,
): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Instagram collection ${label} cannot be empty.`);
  return text;
}

function buildCreateCollectionScript(name: string): string {
  return `(async () => {
    const collectionName = ${JSON.stringify(name)};
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    if (!csrf) return { ok: false, error: 'csrftoken cookie missing; log in to Instagram and retry.' };
    const form = new FormData();
    form.append('name', collectionName);
    form.append('module_name', 'collection_create');
    const response = await fetch('https://www.instagram.com/api/v1/collections/create/', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-IG-App-ID': '936619743392459',
        'X-CSRFToken': csrf,
      },
      body: form,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      return { ok: false, error: 'Failed to create collection: HTTP ' + response.status + (text ? ' - ' + text.slice(0, 200) : '') };
    }
    if (data?.status && data.status !== 'ok') {
      return { ok: false, error: 'Instagram returned non-ok status: ' + JSON.stringify(data).slice(0, 300) };
    }
    return {
      ok: true,
      row: {
        status: 'Created',
        collectionId: String(data?.collection_id ?? ''),
        collectionName: String(data?.collection_name ?? collectionName),
        mediaCount: data?.collection_media_count ?? 0,
      },
    };
  })()`;
}

function buildDeleteCollectionScript(target: string): string {
  return `(async () => {
    const raw = ${JSON.stringify(target)};
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    if (!csrf) return { ok: false, error: 'csrftoken cookie missing; log in to Instagram and retry.' };
    const headers = { 'X-IG-App-ID': '936619743392459' };
    const listResponse = await fetch('https://www.instagram.com/api/v1/collections/list/?collection_types=%5B%22MEDIA%22%5D', {
      credentials: 'include',
      headers,
    });
    if (!listResponse.ok) {
      return { ok: false, error: 'Failed to list collections: HTTP ' + listResponse.status + '; log in to Instagram and retry.' };
    }
    const listData = await listResponse.json();
    const collections = Array.isArray(listData?.items) ? listData.items : [];
    const isNumericId = /^\\d{6,}$/.test(raw);
    let id = '';
    let resolvedName = '';
    if (isNumericId) {
      const hit = collections.find((collection) => String(collection?.collection_id) === raw);
      if (!hit) return { ok: false, error: 'Collection id not found in your account: ' + raw };
      id = String(hit.collection_id);
      resolvedName = String(hit.collection_name || '');
    } else {
      const wanted = raw.toLowerCase();
      const matches = collections.filter((collection) => String(collection?.collection_name || '').trim().toLowerCase() === wanted);
      if (matches.length === 0) {
        const names = collections.map((collection) => collection?.collection_name).filter(Boolean);
        return { ok: false, error: 'Collection not found: ' + raw + '. Available: ' + (names.length ? names.join(', ') : '(none)') };
      }
      if (matches.length > 1) {
        const ids = matches.map((collection) => collection.collection_id).join(', ');
        return { ok: false, error: 'Multiple collections share the name "' + raw + '" (ids: ' + ids + '). Pass the numeric collection_id explicitly.' };
      }
      id = String(matches[0].collection_id);
      resolvedName = String(matches[0].collection_name || raw);
    }
    const form = new FormData();
    form.append('module_name', 'collection_settings');
    const response = await fetch('https://www.instagram.com/api/v1/collections/' + encodeURIComponent(id) + '/delete/', {
      method: 'POST',
      credentials: 'include',
      headers: { ...headers, 'X-CSRFToken': csrf },
      body: form,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      return { ok: false, error: 'Failed to delete collection: HTTP ' + response.status + (text ? ' - ' + text.slice(0, 200) : '') };
    }
    if (data?.status && data.status !== 'ok') {
      return { ok: false, error: 'Instagram returned non-ok status: ' + JSON.stringify(data).slice(0, 300) };
    }
    return {
      ok: true,
      row: {
        status: 'Deleted',
        collectionId: id,
        collectionName: resolvedName,
      },
    };
  })()`;
}

function mapCollectionRow(row: unknown): InstagramCollectionRow {
  const value =
    row && typeof row === "object" ? (row as InstagramCollectionRow) : {};
  return {
    status: String(value.status ?? ""),
    collectionId: String(value.collectionId ?? ""),
    collectionName: String(value.collectionName ?? ""),
    mediaCount:
      value.mediaCount === undefined
        ? undefined
        : Number(value.mediaCount) || 0,
  };
}

cli({
  site: "instagram",
  name: "collection-create",
  description: "Create a new Instagram saved-posts collection",
  domain: "www.instagram.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "name", type: "str", required: true, positional: true }],
  columns: ["status", "collectionId", "collectionName", "mediaCount"],
  func: async (page, kwargs) => {
    const name = requireInstagramCollectionInput(kwargs.name, "name");
    const p = page as IPage;
    await p.goto("https://www.instagram.com");
    const result = (await p.evaluate(
      buildCreateCollectionScript(name),
    )) as InstagramCollectionResult;
    if (!result?.ok) {
      throw new Error(
        String(result?.error || "Instagram collection create failed."),
      );
    }
    return [mapCollectionRow(result.row)];
  },
});

cli({
  site: "instagram",
  name: "collection-delete",
  description: "Delete an Instagram saved-posts collection by name or id",
  domain: "www.instagram.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "target", type: "str", required: true, positional: true }],
  columns: ["status", "collectionId", "collectionName"],
  func: async (page, kwargs) => {
    const target = requireInstagramCollectionInput(kwargs.target, "target");
    const p = page as IPage;
    await p.goto("https://www.instagram.com");
    const result = (await p.evaluate(
      buildDeleteCollectionScript(target),
    )) as InstagramCollectionResult;
    if (!result?.ok) {
      throw new Error(
        String(result?.error || "Instagram collection delete failed."),
      );
    }
    const row = mapCollectionRow(result.row);
    return [
      {
        status: row.status,
        collectionId: row.collectionId,
        collectionName: row.collectionName,
      },
    ];
  },
});
