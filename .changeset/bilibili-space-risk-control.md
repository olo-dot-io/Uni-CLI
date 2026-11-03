---
"@zenalexa/unicli": patch
---

`bilibili user-videos` lists a creator's videos again. Bilibili's space search answered code -352 (risk control) to requests without the browser fingerprint fields its web client sends; the command now sends empty fingerprint fields, raises the API's code and message when it answers with an error, and returns `created` as ISO 8601 with each video's `url`.
