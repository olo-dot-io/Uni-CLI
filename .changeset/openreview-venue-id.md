---
"@zenalexa/unicli": patch
---

`openreview venue` reads a venue id such as `ICLR.cc/2027/Conference/Submission` or `ICLR.cc/2026/Conference/Rejected_Submission` through the anonymous search API. A path without spaces is treated as a venue id; before, it was sent as a venue label, matched nothing, and fell through to the challenged `GET /notes` route.
