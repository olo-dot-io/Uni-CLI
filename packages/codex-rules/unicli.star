# Uni-CLI execution policy for Codex CLI
# Install: copy to ~/.codex/rules/unicli.star

def check(command):
    """Auto-approve unicli commands in workspace-write sandbox."""
    cmd = command.strip()
    if cmd.startswith("unicli ") or cmd.startswith("npx @zenalexa/unicli") or cmd.startswith("npx unicli"):
        return "ALLOW"
    return "PASS"
