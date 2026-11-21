# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to <security@borgels.com>.

Do not include API keys, access tokens, personal data or other secrets in
public GitHub issues. Include a concise description, the affected version,
reproduction steps and the impact where possible.

## Supported versions

Security fixes are made on the `main` branch and in the latest published
release.

## Credential handling

This MCP server reads `QIDI_MOONRAKER_API_KEY` and `MCP_HTTP_TOKEN` only from
the server environment and does not accept credentials as tool arguments. If
you believe they were exposed, replace them on the printer and in the server
environment immediately.
