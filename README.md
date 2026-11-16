# mcp-server-qidi

MCP server for a QIDI X-Plus5 (Klipper + Moonraker) 3D printer: status, chamber
webcam, QIDI Box, G-code files and job history, plus gated control (light,
heater targets, pause/resume/cancel, emergency stop, start print).

This is an independent, unofficial project. It is not developed, endorsed or supported by QIDI Technology.

Moonraker on the Plus5 trusts every LAN client by default and has no
credentials. Unless `QIDI_MOONRAKER_API_KEY` is set, the printer's privacy
therefore rests on the network path (for example a VPN tunnel scoped to the
printer's address) and on whatever authenticates callers in front of this server.

## Tools

| Tool | Tier | |
|---|---|---|
| `qidi_server_status` | read | Printer reachable? Which tiers are on, temperature limits. |
| `qidi_printer_status` | read | State, file, progress, layer, time left, nozzle/bed/chamber temps, loaded Box slot. |
| `qidi_snapshot` | read | Chamber webcam picture (`light=true` switches the light on first; needs control). |
| `qidi_box_status` | read | QIDI Box slots: material, colour, inserted, humidity, drying. |
| `qidi_list_files` / `qidi_file_metadata` | read | G-code on the printer; slicer estimate, filament, temps. |
| `qidi_job_history` | read | Recent jobs with result, duration and filament. |
| `qidi_console` | read | Last console lines — read this when a start failed. |
| `qidi_set_light` | control | Chamber light on/off. |
| `qidi_set_temperature` | control | Nozzle/bed/chamber target, capped by `QIDI_MAX_*_TEMP`. |
| `qidi_pause_print` / `qidi_resume_print` | control | |
| `qidi_cancel_print` | control | Must name the running file, so a stale conversation cannot cancel the wrong job. |
| `qidi_emergency_stop` / `qidi_firmware_restart` | control | M112 and recovery. Restart is refused while printing. |
| `qidi_start_print` | print | Start a file already on the printer. See the plate check below. |

There is deliberately **no raw G-code tool**: every command sent to the printer
is built from enumerated input.

### Plate check

Nobody is standing next to the printer when a print is started from Claude.
`qidi_start_print` refuses unless:

1. the printer is idle (`standby`, `complete`, `cancelled` or `error`),
2. a `qidi_snapshot` was taken in the last `QIDI_PLATE_CHECK_MAX_AGE_MIN` minutes
   (default 15) **and** after the previous job ended — so whoever starts a print
   has been shown the plate after the last part came off it,
3. the caller passes `plateIsEmpty: true`, and
4. the file exists on the printer.

A snapshot is good for one start.

## Configuration

| Env var | Default | |
|---|---|---|
| `QIDI_MOONRAKER_URL` | `http://localhost:7125` | Moonraker base URL. |
| `QIDI_SNAPSHOT_URL` | `<host>/webcam/?action=snapshot` | mjpeg-streamer snapshot. |
| `QIDI_MOONRAKER_API_KEY` | — | Sent as `X-Api-Key`. Set it and remove the server's address range from Moonraker's `trusted_clients`, so only this container can drive the printer. |
| `QIDI_ENABLE_CONTROL` | `false` | Light, temperatures, pause/resume/cancel, e-stop, restart. |
| `QIDI_ENABLE_PRINT_START` | `false` | `qidi_start_print`. |
| `QIDI_MAX_NOZZLE_TEMP` / `_BED_TEMP` / `_CHAMBER_TEMP` | 300 / 110 / 65 | Remote target caps (°C), integers 0-400. |
| `QIDI_PLATE_CHECK_MAX_AGE_MIN` | `15` | Snapshot freshness for a start, integer minutes 1-1440. |
| `QIDI_TIMEOUT_MS` | `10000` | Per-request timeout. |
| `QIDI_AUDIT_LOG` | — | JSONL audit log (who did what; Moonraker logs everything as `_TRUSTED_USER_`). |
| `QIDI_TRUST_FORWARDED_USER` | `false` | Trust `X-MCP-User` from an authenticating gateway. Requires `MCP_HTTP_TOKEN`. |

The numeric `QIDI_*` settings are validated at startup: a value that is not an
integer in range stops the server with a message naming the variable. The tools
re-read the limits on every call and refuse to act if they are invalid, so a typo
can never lift a temperature cap or the plate-check age.

### HTTP transport

`npm run dev:http` (or the Docker image) serves `POST /mcp` and an unauthenticated
`GET /healthz`. It binds to `127.0.0.1` unless `MCP_HTTP_HOST`/`HOST` says otherwise.

| Env var | Default | |
|---|---|---|
| `MCP_HTTP_TOKEN` | — | Bearer token callers must present on `/mcp`; at least 32 printable ASCII characters (e.g. `openssl rand -hex 32`). **Required** on a non-loopback bind (e.g. `0.0.0.0` in a container), with `MCP_ALLOW_ANY_ORIGIN=true` or with `QIDI_TRUST_FORWARDED_USER=true`; the server refuses to start otherwise. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Serve `/mcp` without a token on a non-loopback bind. Only if access is restricted by other means. |
| `MCP_HTTP_HOST` / `HOST`, `PORT` | `127.0.0.1`, `3000` | Bind address and port. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Request body limit. |
| `MCP_ALLOWED_ORIGINS` / `MCP_ALLOW_ANY_ORIGIN` | localhost origins | Browser origins allowed to call `/mcp`. |
| `MCP_ALLOWED_HOSTS` | localhost names on a loopback bind | Host names accepted in the `Host` header (DNS-rebinding protection). |
| `MCP_AUTH_FAILURE_LIMIT` / `MCP_AUTH_FAILURE_WINDOW_MS` | `20` / `60000` | Failed authentication attempts per client address before `429`; `0` disables. Valid tokens are never throttled. |

Moonraker and webcam requests that carry the API key never follow HTTP redirects.

## Security model

- The server drives the printer with **one shared identity**: Moonraker's trusted
  client (or the configured API key). Every MCP client that can call it can use the
  enabled tool tiers.
- Per-user authorization belongs in an identity-aware gateway in front of the
  server. With `QIDI_TRUST_FORWARDED_USER=true` that gateway's user (`X-MCP-User`)
  is written to the audit log; it does not change what the caller may do.
- Tool access is not data access: the tier switches limit the tools, not what
  Moonraker accepts from this server's network address.
- The HTTP server does not terminate TLS. Put it behind a TLS-terminating proxy
  or keep it on a private network.

## Develop

```bash
npm install
npm run typecheck && npm test && npm run build
QIDI_MOONRAKER_URL=http://<printer>:7125 npm run dev        # stdio
```

## License

Apache-2.0
