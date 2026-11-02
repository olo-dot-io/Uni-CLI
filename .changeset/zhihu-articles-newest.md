---
"@zenalexa/unicli": minor
---

`zhihu articles` lists a user's newest articles by default (`--sort created`; `--sort voteups` keeps the old order) and each row carries `id`, `created_at`, `updated_at` and `url`, with vote and comment counts filled in. `zhihu user` returns the `url_token` that `zhihu articles` takes, and accepts the hashed id that `zhihu search` returns.
