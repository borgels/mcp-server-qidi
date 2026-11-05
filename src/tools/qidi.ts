import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { formatUnknownError, PrinterStateError } from '../errors.js';
import { writeAuditEvent } from '../qidi/audit.js';
import type { MoonrakerClient } from '../qidi/client.js';
import {
  checkToolPolicy,
  controlEnabled,
  plateCheckMaxAgeMs,
  printStartEnabled,
  temperatureLimits,
} from '../qidi/policy.js';

export interface QidiToolContext {
  /** Gateway-verified user (X-MCP-User), or undefined on stdio. */
  actingAs?: string;
  now?: () => number;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const CONTROL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** States in which a new job may start (Klipper print_stats.state). */
const IDLE_STATES = new Set(['standby', 'complete', 'cancelled', 'error']);

const fileName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(name => !name.includes('..') && !name.startsWith('/'), 'Path must be relative to the gcodes root, without ..')
  .describe('File name relative to the printer gcodes folder, exactly as qidi_list_files returns it.');

/**
 * The last webcam snapshot handed to a caller, process-wide. Starting a print
 * requires one that is recent AND newer than the end of the previous job,
 * so whoever starts a print has at least been shown the plate after the last
 * part came off it.
 */
let lastSnapshotAt: number | undefined;
export function resetPlateCheck(): void {
  lastSnapshotAt = undefined;
}

export function registerQidiTools(server: McpServer, client: MoonrakerClient, context: QidiToolContext = {}): void {
  const { actingAs } = context;
  const now = context.now ?? Date.now;

  const run = async (tool: string, args: unknown, call: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const policy = checkToolPolicy(tool);
    if (!policy.allowed) {
      await writeAuditEvent({ tool, actingAs, action: 'policy_denied', args, reason: policy.reason });
      return errorResult(policy.reason ?? 'Not allowed');
    }
    await writeAuditEvent({ tool, actingAs, action: 'start', args });
    try {
      const result = await call();
      await writeAuditEvent({ tool, actingAs, action: 'finish', args, status: 'ok' });
      return result;
    } catch (error) {
      await writeAuditEvent({ tool, actingAs, action: 'error', args, status: 'error', error });
      return errorResult(formatUnknownError(error));
    }
  };

  // --- read ---------------------------------------------------------------

  server.registerTool(
    'qidi_server_status',
    {
      title: 'Server status',
      description: 'Which printer this server talks to, which tool tiers are switched on, and whether the printer answers.',
      inputSchema: {},
      annotations: READ,
    },
    async args =>
      run('qidi_server_status', args, async () => {
        let reachable = false;
        let klippy: unknown;
        try {
          const info = await client.get<{ klippy_state?: string }>('/server/info');
          reachable = true;
          klippy = info?.klippy_state;
        } catch (error) {
          klippy = formatUnknownError(error);
        }
        return json({
          moonraker: client.baseUrl,
          reachable,
          klippy,
          actingAs: actingAs ?? null,
          controlEnabled: controlEnabled(),
          printStartEnabled: printStartEnabled(),
          temperatureLimits: temperatureLimits(),
          plateCheckMaxAgeMinutes: plateCheckMaxAgeMs() / 60_000,
        });
      }),
  );

  server.registerTool(
    'qidi_printer_status',
    {
      title: 'Printer status',
      description:
        'Current state of the QIDI X-Plus5: job state, file, progress, layer, elapsed and estimated remaining time, nozzle/bed/chamber temperatures and targets, loaded QIDI Box slot, light.',
      inputSchema: {},
      annotations: READ,
    },
    async args => run('qidi_printer_status', args, async () => json(await printerStatus(client))),
  );

  server.registerTool(
    'qidi_snapshot',
    {
      title: 'Webcam snapshot',
      description:
        'Take a picture with the chamber webcam. Use it to check that the build plate is empty before starting a print, or to look at a running print. ' +
        'Set light=true to switch the chamber light on first (needs the control tier); the picture is dark without it.',
      inputSchema: {
        light: z.boolean().default(false).describe('Switch the chamber light on before taking the picture.'),
      },
      annotations: READ,
    },
    async args =>
      run('qidi_snapshot', args, async () => {
        if (args.light) {
          if (!controlEnabled()) throw new Error('light=true needs QIDI_ENABLE_CONTROL=true on the server');
          await client.gcode('LED_ON');
          await sleep(1500);
        }
        const snap = await client.snapshot();
        lastSnapshotAt = now();
        return {
          content: [
            { type: 'image', data: snap.data.toString('base64'), mimeType: snap.mimeType },
            { type: 'text', text: `Snapshot taken ${new Date(lastSnapshotAt).toISOString()}.` },
          ],
        };
      }),
  );

  server.registerTool(
    'qidi_box_status',
    {
      title: 'QIDI Box status',
      description: 'Filament in each QIDI Box slot (vendor, material, colour, whether filament is inserted), which slot is loaded, box humidity, temperature and drying state.',
      inputSchema: {},
      annotations: READ,
    },
    async args => run('qidi_box_status', args, async () => json(await boxStatus(client))),
  );

  server.registerTool(
    'qidi_list_files',
    {
      title: 'List G-code files',
      description: 'G-code files on the printer, newest first. Optional case-insensitive name filter.',
      inputSchema: {
        filter: z.string().trim().max(100).optional().describe('Only files whose name contains this text.'),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: READ,
    },
    async args =>
      run('qidi_list_files', args, async () => {
        const files = await client.get<Array<{ path: string; modified: number; size: number }>>('/server/files/list', { root: 'gcodes' });
        const needle = args.filter?.toLowerCase();
        const matching = (files ?? [])
          .filter(file => !needle || file.path.toLowerCase().includes(needle))
          .sort((a, b) => b.modified - a.modified);
        return json({
          total: matching.length,
          files: matching.slice(0, args.limit).map(file => ({
            name: file.path,
            modified: isoFromEpoch(file.modified),
            sizeKb: Math.round(file.size / 1024),
          })),
        });
      }),
  );

  server.registerTool(
    'qidi_file_metadata',
    {
      title: 'G-code metadata',
      description: 'Slicer metadata for one file: estimated print time, filament type/name/weight, temperatures, layer height, object height.',
      inputSchema: { filename: fileName },
      annotations: READ,
    },
    async args =>
      run('qidi_file_metadata', args, async () => {
        const meta = await client.get<Record<string, unknown>>('/server/files/metadata', { filename: args.filename });
        return json(fileSummary(meta));
      }),
  );

  server.registerTool(
    'qidi_job_history',
    {
      title: 'Job history',
      description: 'Recent print jobs, newest first: file, result, start/end time, print duration and filament used.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: READ,
    },
    async args =>
      run('qidi_job_history', args, async () => {
        const history = await client.get<{ count: number; jobs: Array<Record<string, unknown>> }>('/server/history/list', {
          limit: args.limit,
          order: 'desc',
        });
        return json({
          total: history?.count,
          jobs: (history?.jobs ?? []).map(job => {
            const meta = (job.metadata ?? {}) as Record<string, unknown>;
            return {
              id: job.job_id,
              file: job.filename,
              status: job.status,
              started: isoFromEpoch(job.start_time),
              ended: isoFromEpoch(job.end_time),
              printMinutes: minutes(job.print_duration),
              filamentMm: round(job.filament_used),
              filament: meta.filament_name ?? meta.filament_type,
              filamentGrams: meta.filament_weight_total,
            };
          }),
        });
      }),
  );

  server.registerTool(
    'qidi_console',
    {
      title: 'Console log',
      description: 'The last lines of the printer console (G-code responses and errors). Read this when a print failed to start or stopped unexpectedly.',
      inputSchema: { count: z.number().int().min(1).max(200).default(40) },
      annotations: READ,
    },
    async args =>
      run('qidi_console', args, async () => {
        const store = await client.get<{ gcode_store: Array<{ message: string; time: number; type: string }> }>('/server/gcode_store', {
          count: args.count,
        });
        return json(
          (store?.gcode_store ?? []).map(line => ({ time: isoFromEpoch(line.time), type: line.type, message: line.message })),
        );
      }),
  );

  // --- control ------------------------------------------------------------

  server.registerTool(
    'qidi_set_light',
    {
      title: 'Chamber light',
      description: 'Switch the chamber light on or off.',
      inputSchema: { on: z.boolean() },
      annotations: CONTROL,
    },
    async args =>
      run('qidi_set_light', args, async () => {
        await client.gcode(args.on ? 'LED_ON' : 'LED_OFF');
        return text(`Light ${args.on ? 'on' : 'off'}.`);
      }),
  );

  server.registerTool(
    'qidi_set_temperature',
    {
      title: 'Set heater target',
      description:
        'Set the target temperature of the nozzle, bed or chamber heater (0 = off). Targets above the server limits are refused. ' +
        'Typical use: switch heaters off, or restore a chamber target that something else reset during a print.',
      inputSchema: {
        heater: z.enum(['nozzle', 'bed', 'chamber']),
        target: z.number().min(0).max(400).describe('°C. 0 switches the heater off.'),
      },
      annotations: CONTROL,
    },
    async args =>
      run('qidi_set_temperature', args, async () => {
        const klipperHeater = { nozzle: 'extruder', bed: 'heater_bed', chamber: 'chamber' } as const;
        const limitKey = { nozzle: 'extruder', bed: 'heater_bed', chamber: 'chamber' } as const;
        const limit = temperatureLimits()[limitKey[args.heater]];
        if (args.target > limit) {
          throw new PrinterStateError(`${args.heater} target ${args.target} °C is above the remote limit of ${limit} °C`);
        }
        const target = Math.round(args.target);
        await client.gcode(`SET_HEATER_TEMPERATURE HEATER=${klipperHeater[args.heater]} TARGET=${target}`);
        return text(`${args.heater} target set to ${target} °C.`);
      }),
  );

  server.registerTool(
    'qidi_pause_print',
    {
      title: 'Pause print',
      description: 'Pause the running print (the printer parks the nozzle). Resume with qidi_resume_print.',
      inputSchema: {},
      annotations: CONTROL,
    },
    async args =>
      run('qidi_pause_print', args, async () => {
        await requireState(client, ['printing'], 'pause');
        await client.post('/printer/print/pause');
        return text('Pause requested.');
      }),
  );

  server.registerTool(
    'qidi_resume_print',
    {
      title: 'Resume print',
      description: 'Resume a paused print.',
      inputSchema: {},
      annotations: CONTROL,
    },
    async args =>
      run('qidi_resume_print', args, async () => {
        await requireState(client, ['paused'], 'resume');
        await client.post('/printer/print/resume');
        return text('Resume requested.');
      }),
  );

  server.registerTool(
    'qidi_cancel_print',
    {
      title: 'Cancel print',
      description: 'Cancel the running or paused print. Cannot be undone: the job is lost. Pass the file name of the running job to confirm which job you mean.',
      inputSchema: {
        filename: fileName.describe('File name of the job you intend to cancel, as qidi_printer_status reports it.'),
      },
      annotations: DESTRUCTIVE,
    },
    async args =>
      run('qidi_cancel_print', args, async () => {
        const stats = await requireState(client, ['printing', 'paused'], 'cancel');
        if (stats.filename !== args.filename) {
          throw new PrinterStateError(`The running job is "${stats.filename}", not "${args.filename}". Nothing was cancelled.`);
        }
        await client.post('/printer/print/cancel');
        return text(`Cancel requested for ${args.filename}.`);
      }),
  );

  server.registerTool(
    'qidi_emergency_stop',
    {
      title: 'Emergency stop',
      description:
        'Immediately halt the printer (M112): heaters and motors stop and the job is lost. Only for a real problem (spaghetti over the hotend, crash, smoke). ' +
        'Afterwards the printer needs qidi_firmware_restart.',
      inputSchema: {
        reason: z.string().trim().min(3).max(300).describe('What is wrong — kept in the audit log.'),
      },
      annotations: DESTRUCTIVE,
    },
    async args =>
      run('qidi_emergency_stop', args, async () => {
        await client.post('/printer/emergency_stop');
        return text('Emergency stop sent. Run qidi_firmware_restart once the cause is dealt with.');
      }),
  );

  server.registerTool(
    'qidi_firmware_restart',
    {
      title: 'Firmware restart',
      description: 'Restart Klipper firmware after an emergency stop or an error/shutdown state. Refused while a job is printing or paused.',
      inputSchema: {},
      annotations: DESTRUCTIVE,
    },
    async args =>
      run('qidi_firmware_restart', args, async () => {
        const info = await client.get<{ klippy_state?: string }>('/server/info');
        if (info?.klippy_state === 'ready') {
          const stats = await printStats(client);
          if (stats.state === 'printing' || stats.state === 'paused') {
            throw new PrinterStateError(`Printer is ${stats.state}; a firmware restart would kill the job.`);
          }
        }
        await client.post('/printer/firmware_restart');
        return text('Firmware restart requested. Check qidi_printer_status in ~30 s.');
      }),
  );

  // --- print --------------------------------------------------------------

  server.registerTool(
    'qidi_start_print',
    {
      title: 'Start print',
      description:
        'Start printing a G-code file that is already on the printer. Before calling: take qidi_snapshot (light=true) and LOOK at the picture — the plate must be empty. ' +
        'The server refuses unless a snapshot was taken in the last few minutes and after the previous job ended, and the printer is idle. ' +
        'After starting, check qidi_printer_status again after ~4 minutes (heating + probing) before reporting that the print is running.',
      inputSchema: {
        filename: fileName,
        plateIsEmpty: z.literal(true).describe('Confirm that you looked at a fresh snapshot and the build plate is empty.'),
      },
      annotations: DESTRUCTIVE,
    },
    async args =>
      run('qidi_start_print', args, async () => {
        const stats = await printStats(client);
        if (!IDLE_STATES.has(stats.state)) {
          throw new PrinterStateError(`Printer is ${stats.state}${stats.filename ? ` (${stats.filename})` : ''}; it must be idle to start a job.`);
        }

        const maxAge = plateCheckMaxAgeMs();
        if (lastSnapshotAt === undefined || now() - lastSnapshotAt > maxAge) {
          throw new PrinterStateError(
            `No webcam snapshot in the last ${maxAge / 60_000} min. Take qidi_snapshot (light=true), check that the plate is empty, then try again.`,
          );
        }
        const lastJob = await client.get<{ jobs: Array<{ end_time?: number | null }> }>('/server/history/list', { limit: 1, order: 'desc' });
        const lastEnd = Number(lastJob?.jobs?.[0]?.end_time ?? 0) * 1000;
        if (lastEnd && lastSnapshotAt < lastEnd) {
          throw new PrinterStateError('The last snapshot is older than the end of the previous job. Take a new qidi_snapshot and check the plate.');
        }

        // Fails with 404 if the file is not there, before anything moves.
        const meta = await client.get<Record<string, unknown>>('/server/files/metadata', { filename: args.filename });
        await client.post('/printer/print/start', { filename: args.filename });
        lastSnapshotAt = undefined; // one look at the plate, one print
        return json({ started: args.filename, ...fileSummary(meta) });
      }),
  );
}

// --- helpers --------------------------------------------------------------

interface PrintStats {
  state: string;
  filename: string;
  print_duration: number;
  total_duration: number;
  filament_used: number;
  message: string;
  info?: { current_layer?: number | null; total_layer?: number | null };
}

async function printStats(client: MoonrakerClient): Promise<PrintStats> {
  const status = await client.queryObjects({ print_stats: null });
  return status.print_stats as unknown as PrintStats;
}

async function requireState(client: MoonrakerClient, states: string[], action: string): Promise<PrintStats> {
  const stats = await printStats(client);
  if (!states.includes(stats.state)) {
    throw new PrinterStateError(`Cannot ${action}: printer is ${stats.state}.`);
  }
  return stats;
}

async function printerStatus(client: MoonrakerClient) {
  const status = await client.queryObjects({
    webhooks: ['state', 'state_message'],
    print_stats: null,
    virtual_sdcard: ['progress', 'is_active'],
    display_status: ['message'],
    extruder: ['temperature', 'target'],
    heater_bed: ['temperature', 'target'],
    'heater_generic chamber': ['temperature', 'target'],
    'output_pin caselight': ['value'],
    box_extras: ['loaded_slot'],
    idle_timeout: ['state'],
  });

  const stats = status.print_stats as unknown as PrintStats;
  const progress = Number(status.virtual_sdcard?.progress ?? 0);
  const elapsed = Number(stats.print_duration ?? 0);
  const remainingSec = progress > 0.02 && elapsed > 0 ? elapsed / progress - elapsed : undefined;
  const heater = (name: string) => {
    const h = status[name];
    return h ? { current: round(h.temperature), target: round(h.target) } : undefined;
  };

  return {
    klippy: status.webhooks?.state,
    klippyMessage: status.webhooks?.state === 'ready' ? undefined : status.webhooks?.state_message,
    state: stats.state,
    file: stats.filename || null,
    progressPercent: Math.round(progress * 1000) / 10,
    layer: stats.info?.current_layer != null ? `${stats.info.current_layer}/${stats.info.total_layer ?? '?'}` : undefined,
    elapsedMinutes: minutes(elapsed),
    remainingMinutesEstimate: remainingSec === undefined ? undefined : minutes(remainingSec),
    filamentUsedMm: round(stats.filament_used),
    message: stats.message || status.display_status?.message || undefined,
    temperatures: {
      nozzle: heater('extruder'),
      bed: heater('heater_bed'),
      chamber: heater('heater_generic chamber'),
    },
    light: status['output_pin caselight'] ? Number(status['output_pin caselight'].value) > 0 : undefined,
    loadedBoxSlot: status.box_extras?.loaded_slot,
    idle: status.idle_timeout?.state,
  };
}

async function boxStatus(client: MoonrakerClient) {
  const status = await client.queryObjects({ box_extras: null });
  const extras = (status.box_extras ?? {}) as {
    loaded_slot?: string;
    boxes?: Array<Record<string, unknown> & { filament_info?: Array<Record<string, unknown>> }>;
  };
  const boxes = (extras.boxes ?? [])
    .map((box, boxIndex) => ({ box, boxIndex }))
    .filter(({ box }) => Number(box.is_online) === 1)
    .map(({ box, boxIndex }) => ({
      box: boxIndex + 1,
      humidityPercent: box.aht20_humidity,
      temperature: box.aht20_temp,
      dryingTarget: box.box_target_temp,
      drying: Number(box.dry_state) !== 0,
      slots: (box.filament_info ?? []).map((slot, i) => ({
        slot: `slot${boxIndex * 4 + i}`,
        filamentInserted: Number(box[`filament_inserted_${i}`]) === 1,
        vendor: slot.vendor_str,
        material: slot.filament_str,
        type: slot.filament_type,
        color: Array.isArray(slot.color_rgb_str) ? slot.color_rgb_str.join(',') : slot.color_rgb_str,
        nozzleRange: slot.min_temp && slot.max_temp ? `${slot.min_temp}-${slot.max_temp} °C` : undefined,
      })),
    }));
  return { loadedSlot: extras.loaded_slot, boxes };
}

function fileSummary(meta: Record<string, unknown> | undefined) {
  if (!meta) return {};
  return {
    file: meta.filename,
    estimatedMinutes: minutes(meta.estimated_time),
    slicer: meta.slicer ? `${meta.slicer} ${meta.slicer_version ?? ''}`.trim() : undefined,
    filament: meta.filament_name ?? meta.filament_type,
    filamentType: meta.filament_type,
    filamentGrams: meta.filament_weight_total,
    layerHeight: meta.layer_height,
    objectHeight: meta.object_height,
    firstLayerNozzle: meta.first_layer_extr_temp,
    firstLayerBed: meta.first_layer_bed_temp,
    chamber: meta.chamber_temp,
    modified: isoFromEpoch(meta.modified),
  };
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function isoFromEpoch(value: unknown): string | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

function minutes(seconds: unknown): number | undefined {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 60) : undefined;
}

function round(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
