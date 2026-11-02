---
"@zenalexa/unicli": minor
---

Browser-backed reads pick up the session the caller selected, and X rows carry time and exact counts.

- `UNICLI_BROWSER_PROFILE_ID` now reaches TypeScript browser adapters such as `twitter` and `reddit`. The managed browser runs inside a long-lived broker, so the invocation scope carries the selected profile id to it.
- The broker reports its package version. A client retires an idle broker started by a different install and starts its own, so an upgrade no longer leaves a broker that imports deleted modules.
- `twitter search`, `tweets`, `user-tweets`, `user-timeline`, `list-tweets`, `thread`, `likes` and `bookmarks` share one row shape: `created_at` (ISO 8601) and integer `likes`, `retweets` and `views`. The browser path reads counts from accessibility labels, which hold exact integers in every interface language.
