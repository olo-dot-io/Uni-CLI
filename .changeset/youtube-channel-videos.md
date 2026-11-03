---
"@zenalexa/unicli": minor
---

`youtube channel-videos <UC id | @handle | channel URL>` lists a channel's recent uploads newest first, with `published` as an exact ISO 8601 time from the player microformat, plus `title`, `views`, `id` and `url`. It resolves a handle through InnerTube `navigation/resolve_url` and pages the Videos tab past 30 uploads. Feed readers can follow channels again, now that the channel RSS answers HTTP 404.
