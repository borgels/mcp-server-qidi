import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoonrakerClient } from '../src/qidi/client.js';
import { createServer } from '../src/server.js';
import { resetPlateCheck } from '../src/tools/qidi.js';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
}

interface PrinterFake {
  state: string;
  filename: string;
  lastJobEnd: number; // epoch seconds
}

function fakePrinter(printer: PrinterFake) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    seen.push({ method, path: url.pathname, query: url.searchParams });
    const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

    if (url.pathname === '/webcam/') return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.pathname === '/printer/objects/query') {
      return ok({
        status: {
          print_stats: { state: printer.state, filename: printer.filename, print_duration: 600, filament_used: 1000, message: '', info: {} },
          virtual_sdcard: { progress: 0.25 },
          webhooks: { state: 'ready' },
          extruder: { temperature: 250.04, target: 250 },
          heater_bed: { temperature: 80, target: 80 },
          'heater_generic chamber': { temperature: 40, target: 0 },
        },
      });
    }
    if (url.pathname === '/server/history/list') return ok({ count: 1, jobs: [{ end_time: printer.lastJobEnd }] });
    if (url.pathname === '/server/files/metadata') {
      if (url.searchParams.get('filename') === 'missing.gcode') return new Response(JSON.stringify({ error: { message: 'Metadata not available' } }), { status: 404 });
      return ok({ filename: url.searchParams.get('filename'), estimated_time: 3600, filament_type: 'PETG' });
    }
    return ok('ok');
  }) as unknown as typeof fetch;
  return { client: new MoonrakerClient({ baseUrl: 'http://printer:7125', fetchImpl, timeoutMs: 1000 }), seen };
}

async function connect(printer: PrinterFake, now: () => number) {
  const fake = fakePrinter(printer);
  const server = createServer({ client: fake.client, onBehalfOf: 'abo@borgels.com', now });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    return { ...result, text: result.content.map(c => c.text ?? '').join('\n') };
  };
  return { call, seen: fake.seen };
}

const T0 = Date.parse('2026-11-05T12:00:00Z');

describe('qidi tools', () => {
  let time = T0;
  const now = () => time;

  beforeEach(() => {
    time = T0;
    resetPlateCheck();
    vi.stubEnv('QIDI_ENABLE_CONTROL', 'true');
    vi.stubEnv('QIDI_ENABLE_PRINT_START', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reports status with temperatures and a remaining-time estimate', async () => {
    const { call } = await connect({ state: 'printing', filename: 'a.gcode', lastJobEnd: 0 }, now);
    const result = await call('qidi_printer_status');
    const status = JSON.parse(result.text);
    expect(status.state).toBe('printing');
    expect(status.progressPercent).toBe(25);
    expect(status.remainingMinutesEstimate).toBe(30);
    expect(status.temperatures.nozzle).toEqual({ current: 250, target: 250 });
  });

  it('refuses to start a print without a fresh snapshot', async () => {
    const { call, seen } = await connect({ state: 'standby', filename: '', lastJobEnd: T0 / 1000 - 3600 }, now);
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/snapshot/);
    expect(seen.some(s => s.path === '/printer/print/start')).toBe(false);
  });

  it('starts after a snapshot, and needs a new snapshot for the next print', async () => {
    const { call, seen } = await connect({ state: 'standby', filename: '', lastJobEnd: T0 / 1000 - 3600 }, now);
    const snap = await call('qidi_snapshot');
    expect(snap.content[0]?.type).toBe('image');
    time += 60_000;
    const started = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(started.isError).toBeFalsy();
    const start = seen.find(s => s.path === '/printer/print/start');
    expect(start?.method).toBe('POST');
    expect(start?.query.get('filename')).toBe('part.gcode');

    const again = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(again.isError).toBe(true);
  });

  it('refuses a snapshot that is too old', async () => {
    const { call } = await connect({ state: 'complete', filename: '', lastJobEnd: T0 / 1000 - 3600 }, now);
    await call('qidi_snapshot');
    time += 16 * 60_000;
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
  });

  it('refuses a snapshot taken before the previous job ended', async () => {
    const { call } = await connect({ state: 'complete', filename: '', lastJobEnd: T0 / 1000 + 30 }, now);
    await call('qidi_snapshot');
    time += 60_000;
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/previous job/);
  });

  it('refuses to start while printing', async () => {
    const { call } = await connect({ state: 'printing', filename: 'other.gcode', lastJobEnd: 0 }, now);
    await call('qidi_snapshot');
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/printing/);
  });

  it('does not start a file that is not on the printer', async () => {
    const { call, seen } = await connect({ state: 'standby', filename: '', lastJobEnd: 0 }, now);
    await call('qidi_snapshot');
    const result = await call('qidi_start_print', { filename: 'missing.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
    expect(seen.some(s => s.path === '/printer/print/start')).toBe(false);
  });

  it('cancels only the job it was told about', async () => {
    const { call, seen } = await connect({ state: 'printing', filename: 'a.gcode', lastJobEnd: 0 }, now);
    const wrong = await call('qidi_cancel_print', { filename: 'b.gcode' });
    expect(wrong.isError).toBe(true);
    expect(seen.some(s => s.path === '/printer/print/cancel')).toBe(false);
    const right = await call('qidi_cancel_print', { filename: 'a.gcode' });
    expect(right.isError).toBeFalsy();
    expect(seen.some(s => s.path === '/printer/print/cancel')).toBe(true);
  });

  it('caps heater targets and builds the G-code from enumerated input', async () => {
    const { call, seen } = await connect({ state: 'printing', filename: 'a.gcode', lastJobEnd: 0 }, now);
    const tooHot = await call('qidi_set_temperature', { heater: 'chamber', target: 90 });
    expect(tooHot.isError).toBe(true);
    await call('qidi_set_temperature', { heater: 'chamber', target: 60 });
    const script = seen.find(s => s.path === '/printer/gcode/script')?.query.get('script');
    expect(script).toBe('SET_HEATER_TEMPERATURE HEATER=chamber TARGET=60');
  });

  it('denies control tools when the control tier is off', async () => {
    vi.stubEnv('QIDI_ENABLE_CONTROL', 'false');
    const { call, seen } = await connect({ state: 'printing', filename: 'a.gcode', lastJobEnd: 0 }, now);
    const result = await call('qidi_pause_print');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/QIDI_ENABLE_CONTROL/);
    expect(seen.some(s => s.path === '/printer/print/pause')).toBe(false);
  });

  it('rejects path traversal in file names', async () => {
    const { call } = await connect({ state: 'standby', filename: '', lastJobEnd: 0 }, now);
    const result = await call('qidi_file_metadata', { filename: '../config/printer.cfg' });
    expect(result.isError).toBe(true);
  });
});

describe('moonraker client', () => {
  it('sends the API key when configured', async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_: unknown, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ result: {} }));
    }) as unknown as typeof fetch;
    await new MoonrakerClient({ baseUrl: 'http://p:7125', apiKey: 'k', fetchImpl }).get('/server/info');
    await new MoonrakerClient({ baseUrl: 'http://p:7125', fetchImpl }).get('/server/info');
    expect(headers[0]?.['x-api-key']).toBe('k');
    expect(headers[1]?.['x-api-key']).toBeUndefined();
  });
});
