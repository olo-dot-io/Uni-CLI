/**
 * Instagram note — publish a text note via GraphQL mutation.
 *
 * Notes are short text messages (max 60 chars) shown in the DM inbox tray.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import type { IPage } from "../../types.js";

const INBOX_URL = "https://www.instagram.com/direct/inbox/";
const NOTE_DOC_ID = "25155183657506484";
const NOTE_MUTATION_NAME = "usePolarisCreateInboxTrayItemSubmitMutation";
const NOTE_ROOT_FIELD = "xdt_create_inbox_tray_item";

function buildPublishNoteJs(content: string): string {
  return `
    (async () => {
      const input = ${JSON.stringify({ content })};
      const html = document.documentElement?.outerHTML || '';
      const scripts = Array.from(document.scripts || [])
        .map(script => script.textContent || '')
        .join('\\n');
      const source = html + '\\n' + scripts;
      const pick = (patterns) => {
        for (const pattern of patterns) {
          const match = source.match(pattern);
          if (!match) continue;
          for (let i = 1; i < match.length; i++) {
            if (match[i]) return match[i];
          }
          return match[0] || '';
        }
        return '';
      };
      const readCookie = (name) => {
        const prefix = name + '=';
        const part = document.cookie.split('; ').find(c => c.startsWith(prefix));
        return part ? decodeURIComponent(part.slice(prefix.length)) : '';
      };
      const actorId = pick([/"actorID":"(\\d+)"/, /"actor_id":"(\\d+)"/, /"viewerId":"(\\d+)"/]);
      const fbDtsg = pick([/(NAF[a-zA-Z0-9:_-]{20,})/, /(NAf[a-zA-Z0-9:_-]{20,})/]);
      const lsd = pick([/"LSD",\\[\\],\\{"token":"([^"]+)"\\}/, /"lsd":"([^"]+)"/]);
      const appId = pick([/"X-IG-App-ID":"(\\d+)"/, /"instagramWebAppId":"(\\d+)"/]);
      const asbdId = pick([/"X-ASBD-ID":"(\\d+)"/]);
      const spinR = pick([/"__spin_r":(\\d+)/]);
      const spinB = pick([/"__spin_b":"([^"]+)"/]);
      const spinT = pick([/"__spin_t":(\\d+)/]);
      const csrfToken = readCookie('csrftoken') || pick([/"csrf_token":"([^"]+)"/]);
      const jazoest = fbDtsg
        ? '2' + Array.from(fbDtsg).reduce((total, char) => total + char.charCodeAt(0), 0)
        : '';

      if (!actorId || !fbDtsg || !lsd || !appId || !csrfToken) {
        return { ok: false, stage: 'config', text: 'Missing required tokens' };
      }

      const variables = {
        input: {
          actor_id: actorId,
          client_mutation_id: '1',
          additional_params: {
            note_create_params: { note_style: 0, text: input.content },
          },
          audience: 0,
          inbox_tray_item_type: 'note',
        },
      };

      const body = new URLSearchParams();
      body.set('av', actorId);
      body.set('__user', '0');
      body.set('__a', '1');
      body.set('__req', '1');
      body.set('dpr', String(window.devicePixelRatio || 1));
      body.set('__rev', spinR);
      body.set('__comet_req', '7');
      body.set('fb_dtsg', fbDtsg);
      body.set('jazoest', jazoest);
      body.set('lsd', lsd);
      body.set('__spin_r', spinR);
      body.set('__spin_b', spinB);
      body.set('__spin_t', spinT);
      body.set('fb_api_caller_class', 'RelayModern');
      body.set('fb_api_req_friendly_name', ${JSON.stringify(NOTE_MUTATION_NAME)});
      body.set('variables', JSON.stringify(variables));
      body.set('server_timestamps', 'true');
      body.set('doc_id', ${JSON.stringify(NOTE_DOC_ID)});

      const headers = {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-ASBD-ID': asbdId || undefined,
        'X-CSRFToken': csrfToken,
        'X-FB-Friendly-Name': ${JSON.stringify(NOTE_MUTATION_NAME)},
        'X-FB-LSD': lsd,
        'X-IG-App-ID': appId,
        'X-Root-Field-Name': ${JSON.stringify(NOTE_ROOT_FIELD)},
      };

      const response = await fetch('/graphql/query', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: body.toString(),
      });
      const text = await response.text();
      const normalizedText = text.replace(/^for \\(;;\\);?/, '').trim();
      let data = null;
      try { data = JSON.parse(normalizedText); } catch {}

      const note = data?.data?.[${JSON.stringify(NOTE_ROOT_FIELD)}]?.inbox_tray_item;
      const noteId = String(note?.inbox_tray_item_id || note?.id || '');
      if (response.ok && noteId) {
        return { ok: true, noteId };
      }
      return { ok: false, stage: 'publish', status: response.status, text: normalizedText };
    })()
  `;
}

cli({
  site: "instagram",
  name: "note",
  description: "Publish a text Instagram note",
  domain: "www.instagram.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: "content",
      positional: true,
      required: true,
      description: "Note text (max 60 characters)",
    },
  ],
  columns: ["status", "detail", "noteId"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const content = String(kwargs.content ?? "").trim();

    if (!content) {
      throw new Error("Instagram note content cannot be empty");
    }
    if (Array.from(content).length > 60) {
      throw new Error("Instagram note content must be 60 characters or fewer");
    }

    await p.goto(INBOX_URL);

    const result = (await p.evaluate(buildPublishNoteJs(content))) as {
      ok?: boolean;
      stage?: string;
      noteId?: string;
      text?: string;
    };

    if (!result?.ok) {
      throw new Error(
        `Note publish failed at ${result?.stage ?? "unknown"}: ${result?.text ?? "unknown error"}`,
      );
    }

    return [
      {
        status: "Posted",
        detail: "Instagram note published successfully",
        noteId: result.noteId ?? "",
      },
    ];
  },
});
