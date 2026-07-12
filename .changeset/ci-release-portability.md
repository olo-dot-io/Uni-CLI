---
"@zenalexa/unicli": patch
---

Make the release gate platform-stable: forced detached update checks now behave
the same under CI, macOS seed simulations declare their platform explicitly,
and generated test inventory no longer varies between macOS and Linux.
