---
"@zenalexa/unicli": minor
---

Twitter/X GraphQL commands resolve the current query id from the signed-in web client when the adapter's id is empty or X answers 404, retry once, and cache every id found for the current main bundle in `~/.unicli/cache/twitter-graphql-operations.json`. A 400 that lists missing features is retried with those features set to true. GraphQL rows read authors, names, counts and bios from the 2026 `user.core`, `user.relationship_counts` and `user.profile_bio` fields, and promoted posts are skipped.

New commands `twitter list-create <name> [--private] [--description <text>]` and `twitter list-members <list>`. `twitter list-add` and `list-remove` now use GraphQL, take `--users a,@b,123` or `--users-file <path>`, read the current members first, change only users whose membership differs at a `--delay` pace (1.5 s by default), wait out a 429, and report `added`, `removed`, `already`, `not-found` or `failed` per user. They replace the browser-UI versions and their single `--user` argument.

`twitter list-tweets` reads `ListLatestTweetsTimeline` and `twitter timeline --following` reads the chronological `HomeLatestTimeline`. Both page with the bottom cursor and accept `--since <ISO date or datetime>`, which ends paging at the first older post. Plain `twitter timeline` keeps the For You feed and now pages too. `twitter following` takes `user` (a handle or a numeric id) in place of `user_id` and pages to `--limit`. `--limit` on the list, timeline and search commands has no fixed maximum, and the defaults stay at 20.

A bare boolean flag such as `--private` or `--following` now means true, and `--flag false` sets false.
