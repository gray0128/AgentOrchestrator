export function renderHelp(): string {
  return [
    "AgentOrchestrator CLI",
    "",
    "Usage:",
    "  ao init-config --repo <owner/name> --repo-path <checkout-path> [--output config/local.json]",
    "  ao doctor --config <path>",
    "  ao validate [--config <path>] [--policy <path>] [--schema-dir <path>]",
    "  ao live-check --config <path>",
    "  ao serve --config <path> [--github-mode mock|live] [--host 127.0.0.1] [--port 3000]",
    "  ao live-smoke --url <service-url> --repo <owner/name> --issue <number>",
    "  ao reconcile --config <path> (--dry-run | --apply)",
    "  ao inspect-run --config <path> (--run-id <id> | --repo <owner/name> --issue <number>)",
    "  ao ui --config <path> [--host 127.0.0.1] [--port 23847]",
    "  ao ui-browser-smoke --config <path> [--run-id <id>] [--headed]",
    "",
    "First run:",
    "  ao init-config --repo gray0128/claw-owner-task --repo-path /path/to/checkout",
    "  ao doctor --config config/local.json",
    "  ao serve --config config/local.json --github-mode live",
    "",
    "Secrets are read from environment variables and are never written by init-config.",
  ].join("\n");
}
