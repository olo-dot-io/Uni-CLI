---
"@zenalexa/unicli": patch
---

A command's envelope reaches a pipe whole. The CLI exited right after writing, and a pipe holds about 64 KiB before
Node buffers the rest, so an agent reading a larger result through a pipe got JSON cut at 65536 bytes. Dispatch now
exits once stdout or stderr has handed the envelope to the OS (`exitAfterWrite` in `src/fast-path/render.ts`).
