export type ToolTier = 'read' | 'control' | 'print';

/**
 * Every tool and its tier. A tool missing here is denied, so a new tool
 * cannot ship without someone deciding which switch it sits behind.
 *
 * - read:    status, camera, files, history. Always on.
 * - control: things that change what the printer is doing right now
 *            (light, temperatures, pause/resume/cancel, emergency stop).
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

/** Upper bounds for remote heater targets. Plus5 hardware max is higher; these are what a remote caller may set. */
export function temperatureLimits(env: NodeJS.ProcessEnv = process.env): TemperatureLimits {
  return {
    extruder: Number(env.QIDI_MAX_NOZZLE_TEMP ?? 300),
    heater_bed: Number(env.QIDI_MAX_BED_TEMP ?? 110),
    chamber: Number(env.QIDI_MAX_CHAMBER_TEMP ?? 65),
  };
}

/** How old the last webcam snapshot may be when a print is started remotely. */
export function plateCheckMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.QIDI_PLATE_CHECK_MAX_AGE_MIN ?? 15) * 60_000;
}
