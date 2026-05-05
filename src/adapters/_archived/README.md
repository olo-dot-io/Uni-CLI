# Archived Adapters

These adapters are preserved for provenance but are outside active discovery.
The loader, manifest builder, conformance report, and quarantine repair list
skip underscore-prefixed adapter directories.

| Site        | Commands    | Archived on | Replacement                                                             |
| ----------- | ----------- | ----------- | ----------------------------------------------------------------------- |
| apple-music | rate-album  | 2026-05-06  | `unicli macos music-now`; `unicli macos music-control <action>`         |
| az          | account     | 2026-05-06  | `az account list --output json` through external CLI passthrough        |
| ctrip       | hot, search | 2026-05-06  | `unicli web read` or browser/CUA against an authenticated Ctrip session |
| gcloud      | projects    | 2026-05-06  | `gcloud projects list --format=json` through external CLI passthrough   |
