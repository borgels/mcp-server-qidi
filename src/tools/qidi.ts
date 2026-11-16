import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { formatUnknownError, PrinterStateError } from '../errors.js';
import { writeAuditEvent } from '../qidi/audit.js';
import type { MoonrakerClient } from '../qidi/client.js';
import {
  dryMaxForType,
  FILAMENT_LIST_FILE,
  type FilamentList,
  findFilament,
  findVendor,
  parseFilamentList,
  UNKNOWN_FILAMENT_DRY_MAX,
} from '../qidi/filament.js';
import {
  boxDryMaxTemp,
  checkToolPolicy,
  controlEnabled,
  plateCheckMaxAgeMs,
  printStartEnabled,
  maxUploadBytes,
  temperatureLimits,
  uploadAllowedHosts,
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
          boxDryMaxTemp: boxDryMaxTemp(),
          uploadAllowedHosts: uploadAllowedHosts(),
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
        // Written as !(<=) so that a non-numeric limit refuses instead of allowing every target.
        if (!(args.target <= limit)) {
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

  // --- QIDI Box ------------------------------------------------------------

  server.registerTool(
    'qidi_box_set_slot',
    {
      title: 'Set QIDI Box slot',
      description:
        "Correct what the printer thinks is in a QIDI Box slot: vendor, material and colour. Material and vendor must match QIDI's filament list on the printer " +
        '(e.g. "PLA Basic", "PETG Basic", "ASA"; vendor "QIDI" or "Generic"); an unknown name is refused and the error lists the valid ones. ' +
        'Keep this right: qidi_box_drying derives its temperature limit from the material in the slots.',
      inputSchema: {
        slot: slotInput,
        vendor: z.string().trim().min(1).max(60),
        material: z.string().trim().min(1).max(60).describe('Filament name from QIDI\'s list, e.g. "PLA Basic".'),
        color: z
          .string()
          .trim()
          .regex(/^#?[0-9A-Fa-f]{6}$/, 'Colour as hex RRGGBB, e.g. #FF0000')
          .describe('Hex colour, e.g. "#1353AB".'),
      },
      annotations: CONTROL,
    },
    async args =>
      run('qidi_box_set_slot', args, async () => {
        await requireCommand(client, ['UPDATE_FILAMENT_INFORMATION']);
        const slot = await requireSlot(client, args.slot);
        const list = await filamentList(client);
        const filament = findFilament(list, args.material);
        if (!filament) {
          throw new PrinterStateError(
            `"${args.material}" is not in QIDI's filament list. Valid materials: ${list.filaments.map(f => f.name).join(', ')}.`,
          );
        }
        const vendor = list.vendors.length ? findVendor(list, args.vendor) : args.vendor;
        if (!vendor) {
          throw new PrinterStateError(`Vendor "${args.vendor}" is not in QIDI's list. Valid vendors: ${list.vendors.join(', ')}.`);
        }
        assertQuotable(vendor);
        assertQuotable(filament.name);
        const color = args.color.replace(/^#/, '').toUpperCase();
        await client.gcode(`UPDATE_FILAMENT_INFORMATION SLOT=${slot.index} COLOR='${color}' VENDOR='${vendor}' FILAMENT='${filament.name}'`);
        return json({ slot: slot.name, vendor, material: filament.name, type: filament.type, color: `#${color}` });
      }),
  );

  server.registerTool(
    'qidi_box_drying',
    {
      title: 'QIDI Box drying',
      description:
        'Start or stop drying in a QIDI Box. The server caps the temperature by the filament in the box: 55 °C when any PLA/PVA/TPU is in it, ' +
        `65 °C for PETG, ABS, ASA, PC, PA and similar, ${UNKNOWN_FILAMENT_DRY_MAX} °C for anything it does not recognise, never above QIDI_MAX_BOX_DRY_TEMP. ` +
        'A request above the cap is refused, not lowered. The cap follows the slot setup, so fix wrong slots with qidi_box_set_slot first.',
      inputSchema: {
        action: z.enum(['start', 'stop']),
        box: z.number().int().min(1).max(4).default(1).describe('Box number, as qidi_box_status reports it.'),
        temperature: z.number().int().min(30).max(90).optional().describe('°C. Required for start.'),
        hours: z.number().int().min(1).max(24).optional().describe('Drying time in whole hours. Required for start.'),
      },
      annotations: CONTROL,
    },
    async args =>
      run('qidi_box_drying', args, async () => {
        const status = await boxStatus(client);
        const box = status.boxes.find(b => b.box === args.box);
        if (!box) throw new PrinterStateError(`Box ${args.box} is not connected. Online boxes: ${status.boxes.map(b => b.box).join(', ') || 'none'}.`);

        if (args.action === 'stop') {
          await requireCommand(client, ['DISABLE_BOX_DRY']);
          await client.gcode(`DISABLE_BOX_DRY BOX=${args.box}`);
          return text(`Drying stopped in box ${args.box}.`);
        }

        if (args.temperature === undefined || args.hours === undefined) {
          throw new PrinterStateError('Starting drying needs both temperature and hours.');
        }
        const limit = dryLimit(box.slots);
        if (!(args.temperature <= limit.max)) {
          throw new PrinterStateError(
            `${args.temperature} °C is above the drying limit of ${limit.max} °C for box ${args.box} (${limit.reason}). Nothing was started.`,
          );
        }
        await requireCommand(client, ['ENABLE_BOX_DRY']);
        await client.gcode(`ENABLE_BOX_DRY BOX=${args.box} TEMP=${args.temperature} END_TIME=${args.hours}`);
        const heater = await client
          .queryObjects({ [`heater_generic heater_box${args.box}`]: ['target', 'temperature'] })
          .then(s => s[`heater_generic heater_box${args.box}`])
          .catch(() => undefined);
        return json({
          box: args.box,
          drying: true,
          target: args.temperature,
          hours: args.hours,
          limit: limit.max,
          limitReason: limit.reason,
          heaterTargetNow: heater ? round(heater.target) : undefined,
          heaterTemperatureNow: heater ? round(heater.temperature) : undefined,
        });
      }),
  );

  for (const [tool, verb, commands] of [
    ['qidi_box_load', 'load', ['LOAD_FILAMENT_CONTROL', 'E_LOAD']],
    ['qidi_box_unload', 'unload', ['UNLOAD_FILAMENT_CONTROL', 'E_UNLOAD']],
  ] as const) {
    server.registerTool(
      tool,
      {
        title: verb === 'load' ? 'Load filament from QIDI Box' : 'Unload filament to QIDI Box',
        description:
          (verb === 'load'
            ? 'Load the filament from a QIDI Box slot into the toolhead (heats, cuts and unloads the current filament first). '
            : 'Unload the filament of a QIDI Box slot from the toolhead back into the Box. ') +
          'Refused while a print is running or paused. The change takes ~2-3 minutes; the tool returns once the printer accepted it — check qidi_box_status afterwards.',
        inputSchema: { slot: slotInput },
        annotations: CONTROL,
      },
      async args =>
        run(tool, args, async () => {
          const stats = await printStats(client);
          if (stats.state === 'printing' || stats.state === 'paused') {
            throw new PrinterStateError(`Printer is ${stats.state}${stats.filename ? ` (${stats.filename})` : ''}; filament cannot be ${verb}ed during a print.`);
          }
          const slot = await requireSlot(client, args.slot);
          if (verb === 'load' && !slot.filamentInserted) {
            throw new PrinterStateError(`${slot.name} has no filament inserted.`);
          }
          const command = await requireCommand(client, commands);
          const finished = await acceptLongCommand(client, `${command} SLOT=${slot.index}`, async error => {
            await writeAuditEvent({ tool, actingAs, action: 'error', args, status: 'error', error });
          });
          return text(
            finished
              ? `${verb === 'load' ? 'Loaded' : 'Unloaded'} ${slot.name}.`
              : `${verb === 'load' ? 'Loading' : 'Unloading'} ${slot.name} started; it takes a few minutes. Check qidi_box_status / qidi_console afterwards.`,
          );
        }),
    );
  }

  server.registerTool(
    'qidi_upload_file',
    {
      title: 'Upload G-code',
      description:
        'Put a sliced G-code file on the printer (it is not started; use qidi_start_print for that). Give either the G-code text in `content`, ' +
        'or an https `url` on a host the server allows (QIDI_UPLOAD_ALLOWED_HOSTS). Refuses to replace an existing file unless overwrite=true, and never replaces the file being printed.',
      inputSchema: {
        filename: fileName.refine(name => /\.gcode$/i.test(name), 'File name must end in .gcode'),
        content: z.string().min(1).optional().describe('The G-code text.'),
        url: z.url().optional().describe('https URL to download the G-code from.'),
        overwrite: z.boolean().default(false),
      },
      annotations: CONTROL,
    },
    async args =>
      run('qidi_upload_file', args, async () => {
        if ((args.content === undefined) === (args.url === undefined)) {
          throw new PrinterStateError('Give exactly one of content or url.');
        }
        const files = await client.get<Array<{ path: string }>>('/server/files/list', { root: 'gcodes' });
        const exists = (files ?? []).some(file => file.path === args.filename);
        if (exists) {
          const stats = await printStats(client);
          if ((stats.state === 'printing' || stats.state === 'paused') && stats.filename === args.filename) {
            throw new PrinterStateError(`${args.filename} is the job being printed; it cannot be replaced now.`);
          }
          if (!args.overwrite) throw new PrinterStateError(`${args.filename} already exists on the printer. Pass overwrite=true to replace it.`);
        }

        const data = args.content !== undefined ? new TextEncoder().encode(args.content) : await download(args.url!);
        if (data.byteLength > maxUploadBytes()) {
          throw new PrinterStateError(`File is ${Math.round(data.byteLength / 1024 / 1024)} MB, above the ${maxUploadBytes() / 1024 / 1024} MB limit.`);
        }
        await client.upload(args.filename, data);
        return json({ uploaded: args.filename, sizeKb: Math.round(data.byteLength / 1024), replaced: exists });
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
        if (lastSnapshotAt === undefined || !(now() - lastSnapshotAt <= maxAge)) {
          throw new PrinterStateError(
            `No webcam snapshot in the last ${maxAge / 60_000} min. Take qidi_snapshot (light=true), check that the plate is empty, then try again.`,
          );
        }
        const lastJob = await client.get<{ jobs?: unknown }>('/server/history/list', { limit: 1, order: 'desc' });
        // Fail closed: a history or end time that cannot be read must not skip the check.
        const jobs = lastJob?.jobs;
        if (!Array.isArray(jobs)) {
          throw new PrinterStateError('The print history could not be read, so the plate check cannot be confirmed. Try again later.');
        }
        const rawEnd = (jobs[0] as { end_time?: unknown } | undefined)?.end_time;
        if (rawEnd !== undefined && rawEnd !== null && (typeof rawEnd !== 'number' || !Number.isFinite(rawEnd) || rawEnd < 0)) {
          throw new PrinterStateError('The end time of the previous job could not be read, so the plate check cannot be confirmed.');
        }
        const lastEnd = (typeof rawEnd === 'number' ? rawEnd : 0) * 1000;
        if (lastEnd > 0 && !(lastSnapshotAt >= lastEnd)) {
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

interface SlotInfo {
  slot: string;
  filamentInserted: boolean;
  material?: unknown;
  type?: unknown;
}

/** Highest drying temperature allowed for a box, from the filament inserted in its slots. */
export function dryLimit(slots: SlotInfo[]): { max: number; reason: string } {
  const ceiling = boxDryMaxTemp();
  let max = ceiling;
  let reason = `server ceiling QIDI_MAX_BOX_DRY_TEMP=${ceiling} °C`;
  for (const slot of slots.filter(s => s.filamentInserted)) {
    const type = typeof slot.type === 'string' && slot.type ? slot.type : typeof slot.material === 'string' ? slot.material : undefined;
    const slotMax = dryMaxForType(type);
    if (slotMax < max) {
      max = slotMax;
      reason = `${slot.slot} holds ${type ?? 'unknown filament'}`;
    }
  }
  return { max, reason };
}

/** Slot as "slot3" (as qidi_box_status reports it) or 3. */
const slotInput = z
  .union([z.number().int().min(0).max(15), z.string().trim().regex(/^slot\d{1,2}$/i, 'Slot as "slot0".."slot15"')])
  .transform(value => (typeof value === 'number' ? value : Number(value.slice(4))))
  .refine(n => n >= 0 && n <= 15, 'Slot must be slot0..slot15')
  .describe('Box slot, as qidi_box_status names it ("slot0" = box 1 slot 1, "slot4" = box 2 slot 1).');

async function requireSlot(client: MoonrakerClient, index: number) {
  const status = await boxStatus(client);
  const name = `slot${index}`;
  const slot = status.boxes.flatMap(box => box.slots).find(s => s.slot === name);
  if (!slot) throw new PrinterStateError(`${name} is not in a connected QIDI Box.`);
  return { ...slot, index, name };
}

/** First of `names` the printer's Klipper knows, so we never send a command QIDI's firmware lacks. */
async function requireCommand(client: MoonrakerClient, names: readonly string[]): Promise<string> {
  const known = await client.gcodeCommands();
  const found = names.find(name => known.has(name));
  if (!found) throw new PrinterStateError(`This printer firmware has no ${names.join(' / ')} command.`);
  return found;
}

async function filamentList(client: MoonrakerClient): Promise<FilamentList> {
  const list = parseFilamentList(await client.fileText('config', FILAMENT_LIST_FILE));
  if (!list.filaments.length) throw new Error(`${FILAMENT_LIST_FILE} on the printer lists no filaments`);
  return list;
}

/** Values go between single quotes in G-code. */
function assertQuotable(value: string): void {
  if (/['\r\n]/.test(value)) throw new PrinterStateError(`"${value}" cannot be sent to the printer (quote or line break).`);
}

/** How long a long-running command gets to fail fast before we report it as started. */
const ACCEPT_WINDOW_MS = 5_000;

/**
 * Run a G-code command that takes minutes (a filament change). Moonraker answers
 * only when it is done, so wait briefly for an immediate rejection, then return
 * false ("still running") and hand any later failure to `onLateError`.
 */
async function acceptLongCommand(client: MoonrakerClient, script: string, onLateError: (error: unknown) => Promise<void>): Promise<boolean> {
  const pending = client.gcode(script, { timeoutMs: 10 * 60_000 });
  let timer: NodeJS.Timeout | undefined;
  const window = new Promise<'running'>(resolve => {
    timer = setTimeout(() => resolve('running'), ACCEPT_WINDOW_MS);
  });
  try {
    const outcome = await Promise.race([pending.then(() => 'done' as const), window]);
    if (outcome === 'running') pending.catch(error => onLateError(error).catch(() => undefined));
    return outcome === 'done';
  } finally {
    clearTimeout(timer);
  }
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const parsed = new URL(url);
  const allowed = uploadAllowedHosts();
  if (parsed.protocol !== 'https:') throw new PrinterStateError('Only https URLs can be downloaded.');
  if (!allowed.includes(parsed.hostname.toLowerCase())) {
    throw new PrinterStateError(
      allowed.length ? `${parsed.hostname} is not in QIDI_UPLOAD_ALLOWED_HOSTS (${allowed.join(', ')}).` : 'URL uploads are off (QIDI_UPLOAD_ALLOWED_HOSTS is empty); pass content instead.',
    );
  }
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxUploadBytes()) throw new PrinterStateError(`File is larger than the ${maxUploadBytes() / 1024 / 1024} MB limit.`);
  return new Uint8Array(await response.arrayBuffer());
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
