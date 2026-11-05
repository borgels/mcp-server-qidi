# mcp-server-qidi

MCP server for a QIDI X-Plus5 (Klipper + Moonraker) 3D printer: status, chamber
webcam, QIDI Box, G-code files and job history, plus gated control (light,
heater targets, pause/resume/cancel, emergency stop, start print).

Moonraker on the Plus5 trusts every LAN client and has no credentials. The
printer's privacy therefore rests on the network path (in our deployment a
WireGuard tunnel scoped to the printer's single address) and on the
Entra-authenticated gateway in front of this server.

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
| `QIDI_ENABLE_CONTROL` | `false` | Light, temperatures, pause/resume/cancel, e-stop, restart. |
| `QIDI_ENABLE_PRINT_START` | `false` | `qidi_start_print`. |
| `QIDI_MAX_NOZZLE_TEMP` / `_BED_TEMP` / `_CHAMBER_TEMP` | 300 / 110 / 65 | Remote target caps (°C). |
| `QIDI_PLATE_CHECK_MAX_AGE_MIN` | `15` | Snapshot freshness for a start. |
| `QIDI_TIMEOUT_MS` | `10000` | Per-request timeout. |
| `QIDI_AUDIT_LOG` | — | JSONL audit log (who did what; Moonraker logs everything as `_TRUSTED_USER_`). |
| `QIDI_TRUST_FORWARDED_USER` | `false` | Trust `X-MCP-User` from the gateway. Requires `MCP_HTTP_TOKEN`. |
| `MCP_HTTP_TOKEN` | — | Bearer the gateway must present (HTTP transport). |

## Develop

```bash
npm install
npm run typecheck && npm test && npm run build
QIDI_MOONRAKER_URL=http://<printer>:7125 npm run dev        # stdio
```

## License

Apache-2.0
