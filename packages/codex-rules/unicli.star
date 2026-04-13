# Uni-CLI execution policy for Codex CLI
# Install: copy to ~/.codex/rules/unicli.star

def check(command):
    """Auto-approve safe unicli commands."""
    cmd = command.strip()
    # Only auto-approve read-only site commands and discovery
    safe_prefixes = [
        "unicli list",
        "unicli schema",
        "unicli test",
        "unicli mcp",
        "unicli auth check",
        "unicli auth list",
        "unicli repair",
        "unicli status",
    ]
    for prefix in safe_prefixes:
        if cmd.startswith(prefix):
            return "ALLOW"
    # For site commands (unicli <site> <cmd>), allow read operations
    # but require approval for operate, auth setup, and other write ops
    parts = cmd.split()
    if len(parts) >= 3 and parts[0] == "unicli":
        if parts[1] not in ("operate", "auth", "browser", "daemon", "record", "eval"):
            return "ALLOW"
    return "PASS"
