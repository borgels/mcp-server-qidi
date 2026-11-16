import { type Env, readEnvInteger } from '../config-env.js';

export type ToolTier = 'read' | 'control' | 'print';

/**
 * Every tool and its tier. A tool missing here is denied, so a new tool
 * cannot ship without someone deciding which switch it sits behind.
 *
 * - read:    status, camera, files, history. Always on.
 * - control: things that change what the printer is doing right now
 *            (light, temperatures, pause/resume/cancel, emergency stop,
 *            QIDI Box slot setup/drying/load/unload, G-code upload).
 *            QIDI_ENABLE_CONTROL=true.
 * - print:   starting a job, the one action that moves a hot nozzle over a
 *            plate nobody is standing next to. QIDI_ENABLE_PRINT_START=true.
 */
export const TOOL_TIERS: Record<string, ToolTier> = {
  qidi_server_status: 'read',
  qidi_printer_status: 'read',
  qidi_snapshot: 'read',
  qidi_box_status: 'read',
  qidi_list_files: 'read',
  qidi_file_metadata: 'read',
  qidi_job_history: 'read',
  qidi_console: 'read',
  qidi_set_light: 'control',
  qidi_set_temperature: 'control',
  qidi_pause_print: 'control',
  qidi_resume_print: 'control',
  qidi_cancel_print: 'control',
  qidi_emergency_stop: 'control',
  qidi_firmware_restart: 'control',
  qidi_box_set_slot: 'control',
  qidi_box_drying: 'control',
  qidi_box_load: 'control',
  qidi_box_unload: 'control',
  qidi_upload_file: 'control',
  qidi_start_print: 'print',
};

export function controlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QIDI_ENABLE_CONTROL === 'true';
}

export function printStartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QIDI_ENABLE_PRINT_START === 'true';
}

export function checkToolPolicy(tool: string, env: NodeJS.ProcessEnv = process.env): { allowed: boolean; reason?: string } {
  const tier = TOOL_TIERS[tool];
  if (!tier) return { allowed: false, reason: `Unknown tool ${tool}` };
  if (tier === 'control' && !controlEnabled(env)) {
    return { allowed: false, reason: `${tool} needs QIDI_ENABLE_CONTROL=true on the server` };
  }
  if (tier === 'print' && !printStartEnabled(env)) {
    return { allowed: false, reason: `${tool} needs QIDI_ENABLE_PRINT_START=true on the server` };
  }
  return { allowed: true };
}

export interface TemperatureLimits {
  extruder: number;
  heater_bed: number;
  chamber: number;
}

/** Highest value accepted for any QIDI_MAX_*_TEMP setting (matches the tool's input schema). */
export const MAX_CONFIGURABLE_TEMP = 400;

/**
 * Upper bounds for remote heater targets. Plus5 hardware max is higher; these are what a remote caller may set.
 * Each value must be an integer from 0 to MAX_CONFIGURABLE_TEMP; anything else throws a ConfigError, so a typo
 * can never turn into NaN (`target > NaN` is false and would allow any target).
 */
export function temperatureLimits(env: Env = process.env): TemperatureLimits {
  const limit = { min: 0, max: MAX_CONFIGURABLE_TEMP };
  return {
    extruder: readEnvInteger('QIDI_MAX_NOZZLE_TEMP', 300, limit, env),
    heater_bed: readEnvInteger('QIDI_MAX_BED_TEMP', 110, limit, env),
    chamber: readEnvInteger('QIDI_MAX_CHAMBER_TEMP', 65, limit, env),
  };
}

/**
 * How old the last webcam snapshot may be when a print is started remotely: an integer number of minutes
 * from 1 to 1440. Invalid values throw a ConfigError instead of becoming NaN (which would let a stale check pass).
 */
export function plateCheckMaxAgeMs(env: Env = process.env): number {
  return readEnvInteger('QIDI_PLATE_CHECK_MAX_AGE_MIN', 15, { min: 1, max: 1440 }, env) * 60_000;
}

/** Per-request timeout for Moonraker and the webcam (1 ms to 10 minutes). */
export function requestTimeoutMs(env: Env = process.env): number {
  return readEnvInteger('QIDI_TIMEOUT_MS', 10_000, { min: 1, max: 600_000 }, env);
}

/**
 * Validates every numeric QIDI_* setting. Called at startup so a bad value stops the server;
 * the tools also re-read the limits per call and refuse to act when they are invalid.
 */
export function validateQidiEnv(env: Env = process.env): void {
  temperatureLimits(env);
  plateCheckMaxAgeMs(env);
  requestTimeoutMs(env);
  boxDryMaxTemp(env);
  maxUploadBytes(env);
}

/** Hard ceiling for a QIDI Box drying target, whatever the filament (°C). */
export function boxDryMaxTemp(env: Env = process.env): number {
  return readEnvInteger('QIDI_MAX_BOX_DRY_TEMP', 65, { min: 30, max: 90 }, env);
}

/** Largest G-code upload accepted (MB). */
export function maxUploadBytes(env: Env = process.env): number {
  return readEnvInteger('QIDI_MAX_UPLOAD_MB', 100, { min: 1, max: 1024 }, env) * 1024 * 1024;
}

/**
 * Hosts qidi_upload_file may download from (https only). Empty = URL uploads
 * are off, so the server cannot be pointed at arbitrary addresses on its network.
 */
export function uploadAllowedHosts(env: Env = process.env): string[] {
  return (env.QIDI_UPLOAD_ALLOWED_HOSTS ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}
