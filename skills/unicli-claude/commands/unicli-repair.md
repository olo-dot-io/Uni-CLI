Diagnose and fix a broken Uni-CLI adapter from the original failure evidence.

Usage: /unicli-repair <site> <command>

First preserve the failed command and structured envelope. Do not edit source
for auth, challenge, network, or rate-limit failures. When current endpoint/DOM
evidence proves adapter drift, read `error.adapter_path`, make one root-cause
edit, then verify the exact original command with:

Run: unicli repair $ARGUMENTS

The repair command is a verifier; it never edits files or invokes an AI backend.
