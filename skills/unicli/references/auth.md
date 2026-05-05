# Authentication & Strategy Reference

How unicli handles authentication: from public APIs to full browser login flows.

---

## Strategy Cascade (Auto-Probe)

On first run, unicli probes strategies in order and caches the result:

```
public → cookie → header
```

Browser strategies (`intercept`, `ui`) never auto-promote — they require explicit
opt-in via the YAML adapter's `strategy:` field.

| Strategy    | Requires                        | When used                                  |
| ----------- | ------------------------------- | ------------------------------------------ |
| `public`    | Nothing                         | Open APIs, no auth                         |
| `cookie`    | `~/.unicli/cookies/<site>.json` | Login-gated; auto-exported from browser    |
| `header`    | Cookie + CSRF token             | Cookie + per-request CSRF (auto-extracted) |
| `intercept` | Browser CDP session             | Navigate page, capture XHR; no direct API  |
| `ui`        | Browser CDP session             | Click through login or interact with page  |

---

## First-Time Setup Workflow

```bash
# 1. Start setup — unicli opens a browser window
unicli auth setup <site>

# 2. Log in to the site in the browser window
# 3. unicli detects cookies and saves them automatically

# 4. Verify
unicli auth status <site>

# 5. Test the command
unicli <site> <command>
```

---

## Auth Commands Reference

```bash
unicli auth setup <site>       # guided browser login + cookie export
unicli auth status <site>      # check cookie file exists + expiry
unicli auth list               # all authenticated sites
unicli auth refresh <site>     # re-export cookies (when expired)
unicli auth remove <site>      # delete stored credentials
```

---

## Cookie File Location

```
~/.unicli/cookies/<site>.json
```

- Files are JSON arrays of cookie objects (Netscape/WebKit format).
- **Never read or edit cookie files directly** — use `unicli auth` commands.
- Cookie files are per-site; one site can have one active cookie file.
- Expiry: cookies expire per the site's session policy (hours to months).

---

## Exit Code 77 — Auth Required

When you see exit 77 (`auth_required` or `not_authenticated`):

```bash
# Step 1: Check which sites need auth
unicli auth list

# Step 2: Set up auth
unicli auth setup <site>

# Step 3: Retry the failed command
unicli <site> <command>
```

---

## Site-Specific Auth Notes

### Chinese social platforms (Weibo, Zhihu, Bilibili, Douyin)

- Cookie-based; sessions typically last 7–30 days.
- Re-run `unicli auth setup <site>` after expiry.
- Bilibili has anti-bot measures — use `unicli auth setup bilibili` in headful mode.

### Twitter / X

- Cookie-based via browser session.
- Twitter aggressively rotates session tokens; may need monthly refresh.
- `unicli auth status twitter` shows last-updated timestamp.

### Reddit

- Most listing commands work without auth (`public`).
- Search and user commands may need auth for personalized results.

### LinkedIn

- Requires auth for most commands.
- Sessions last weeks; refresh on 77 errors.

### Financial platforms (Xueqiu, Eastmoney, Futu)

- Xueqiu hot/hot-stock are public.
- Portfolio/watchlist commands require auth.

### E-commerce (Amazon, JD, Taobao)

- Hot/search are public.
- Cart/order/account commands require auth.

### GitHub / GitLab

- Public repo commands work without auth.
- `gh` bridge commands use your local `gh auth` token, not unicli cookies.
- `unicli gh pr list` → delegates to `gh cli` (must have `gh auth login` done).

### AI platforms (Claude, ChatGPT, Deepseek)

- Require auth for all commands.
- Browser-based auth; sessions last weeks.
- Use `unicli claude chat "..."` for quick one-off calls.

---

## Browser Strategy — When Cookie Is Not Enough

Some sites require JavaScript rendering or have bot detection that blocks API calls.
For these, unicli uses `intercept` or `ui` strategy via Chrome CDP.

**Pre-requisite**: `unicli browser start` must be running.

### Intercept strategy

The adapter navigates to the page, captures XHR/fetch responses, and extracts data
from the network traffic — no DOM scraping, highly reliable.

```bash
unicli browser start
unicli <site> <command>   # adapter auto-uses intercept strategy
```

### UI strategy

The adapter interacts with the page (click, type, scroll) to trigger data loading,
then extracts via DOM accessibility snapshot.

```bash
unicli browser start
unicli browser status     # confirm CDP is alive
unicli <site> <command>   # adapter auto-uses ui strategy
```

For building new adapters with these strategies, load skill `unicli-explorer`.

---

## Troubleshooting Auth

### Symptoms and fixes

| Symptom                                   | Fix                                                               |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Exit 77, `auth_required`                  | `unicli auth setup <site>`                                        |
| Commands work then fail hours later       | Cookie expired — `unicli auth refresh <site>`                     |
| `unicli auth status <site>` shows no file | Cookie was never set up — run `unicli auth setup <site>`          |
| Browser window opens but login hangs      | Try `unicli browser start` first, then `unicli auth setup <site>` |
| "permission_denied" after login           | Account lacks access to that resource                             |
| Auth succeeds but command still fails     | Check `unicli health` — may be adapter issue, not auth            |

### Verify the full auth chain

```bash
unicli doctor                   # system health: Node, Chrome, auth files, index
unicli auth list                # which sites have cookies
unicli auth status <site>       # cookie file freshness
unicli browser status           # CDP session alive?
```
