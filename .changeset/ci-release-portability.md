---
"@zenalexa/unicli": patch
---

Make the release gate platform-stable: forced detached update checks now behave
the same under CI, macOS seed simulations declare their platform explicitly,
profile-seed manifests use portable relative paths, Git reference fixtures own
their line-ending policy, and generated test inventory no longer varies across
macOS, Linux, and Windows.
