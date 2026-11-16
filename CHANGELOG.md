# Changelog

## Unreleased

- `qidi_box_set_slot`: vendor, material and colour of a QIDI Box slot, validated against QIDI's filament list on the printer.
- `qidi_box_drying`: start/stop drying; target capped by the material set up in every slot of the box (sensors ignored; ejected spools still count); Plus5 `BOX_START_DRYING`/`BOX_STOP_DRYING` (55 °C PLA/PVA/TPU, 65 °C PETG/ABS/ASA/PC/PA, 50 °C unknown) and `QIDI_MAX_BOX_DRY_TEMP`.
- `qidi_box_load` / `qidi_box_unload`: refused while printing or paused.
- `qidi_upload_file`: inline G-code or https from `QIDI_UPLOAD_ALLOWED_HOSTS`; never replaces the running job.

## 0.2.0

### Upgrade notes

- The HTTP server refuses to start on a non-loopback bind (`MCP_HTTP_HOST`/`HOST`,
  e.g. `0.0.0.0`) or with `MCP_ALLOW_ANY_ORIGIN=true` unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` restores the old behaviour explicitly.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- `QIDI_MAX_NOZZLE_TEMP`, `QIDI_MAX_BED_TEMP`, `QIDI_MAX_CHAMBER_TEMP` (integers
  0-400), `QIDI_PLATE_CHECK_MAX_AGE_MIN` (1-1440), `QIDI_TIMEOUT_MS`, `PORT`,
  `MCP_MAX_BODY_BYTES` and boolean flags such as `QIDI_TRUST_FORWARDED_USER` are
  validated at startup; invalid values stop the server. Previously a typo in a
  temperature cap or the plate-check age became `NaN`, which disabled the check.
- `QIDI_TRUST_FORWARDED_USER` and the `MCP_*` boolean flags now accept `true/false`,
  `1/0`, `yes/no`, `on/off` and reject anything else, so `QIDI_TRUST_FORWARDED_USER=1`,
  `yes` or `on` now enable trust. `QIDI_ENABLE_CONTROL` and `QIDI_ENABLE_PRINT_START`
  are unchanged and still need exactly `true`.
- A blank temperature cap or plate-check age (e.g. `QIDI_MAX_BED_TEMP=`) now means
  the default; previously it was read as `0`.
- The `Bearer` scheme in `Authorization` is matched case-insensitively.

### Changes

- Temperature caps and the plate-check age fail closed: the tools refuse to act
  when a limit is invalid.
- `qidi_start_print` refuses when the print history or the previous job's end
  time cannot be read (missing job list, non-numeric or negative end time),
  instead of skipping the "snapshot after the last job" check. An empty
  history still allows a start.
- Webcam snapshot redirects are only followed to `http`/`https` URLs.
- HTTP transport: failed-authentication limiting per client address (`429` with
  `Retry-After`; new `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`), `Host`
  header check on loopback binds (new `MCP_ALLOWED_HOSTS`), `401` with
  `WWW-Authenticate`, `400` for invalid JSON, `413` before reading an oversized
  body, `GET /healthz`, graceful shutdown on `SIGTERM`/`SIGINT`.
- Moonraker API requests no longer follow redirects, and webcam snapshot requests
  follow at most two redirects (same origin only when an API key is set), so
  `X-Api-Key` is never re-sent to another host. Error bodies are
  read up to 64 KB and the API key is redacted before the text is truncated.
- The server reports the package version.
- Docker image is published only after CI passes, with SBOM and provenance; GitHub
  Actions are pinned to commit SHAs; dependency updates.

## 0.1.0

- Initial release.
