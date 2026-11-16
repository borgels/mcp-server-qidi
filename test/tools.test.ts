import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../src/config-env.js';
import { MoonrakerClient } from '../src/qidi/client.js';
import { plateCheckMaxAgeMs, temperatureLimits, validateQidiEnv } from '../src/qidi/policy.js';
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
  history?: unknown; // overrides the history/list result
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
    if (url.pathname === '/server/history/list') return ok(printer.history !== undefined ? printer.history : { count: 1, jobs: [{ end_time: printer.lastJobEnd }] });
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
  const server = createServer({ client: fake.client, onBehalfOf: 'user@example.com', now });
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

  it('refuses to start when the previous job end time is not a number', async () => {
    const { call, seen } = await connect({ state: 'complete', filename: '', lastJobEnd: 'not-a-time' as unknown as number }, now);
    await call('qidi_snapshot');
    time += 60_000;
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
    expect(seen.some(s => s.path === '/printer/print/start')).toBe(false);
  });

  it.each([
    ['empty-string end time', { count: 1, jobs: [{ end_time: '' }] }],
    ['boolean end time', { count: 1, jobs: [{ end_time: false }] }],
    ['array end time', { count: 1, jobs: [{ end_time: [] }] }],
    ['negative end time', { count: 1, jobs: [{ end_time: -5 }] }],
    ['missing jobs array', {}],
    ['jobs not an array', { jobs: {} }],
    ['string result', 'oops'],
  ])('refuses to start when the print history is unreadable (%s)', async (_label, history) => {
    const { call, seen } = await connect({ state: 'complete', filename: '', lastJobEnd: 0, history }, now);
    await call('qidi_snapshot');
    time += 60_000;
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
    expect(seen.some(s => s.path === '/printer/print/start')).toBe(false);
  });

  it('starts when there is no previous job', async () => {
    const { call, seen } = await connect({ state: 'standby', filename: '', lastJobEnd: 0, history: { count: 0, jobs: [] } }, now);
    await call('qidi_snapshot');
    time += 60_000;
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBeFalsy();
    expect(seen.some(s => s.path === '/printer/print/start')).toBe(true);
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

  it('refuses every heater target when a temperature limit is not a number', async () => {
    for (const value of ['abc', '65C', '', ' ']) {
      vi.stubEnv('QIDI_MAX_CHAMBER_TEMP', value);
      const { call, seen } = await connect({ state: 'printing', filename: 'a.gcode', lastJobEnd: 0 }, now);
      const result = await call('qidi_set_temperature', { heater: 'chamber', target: 90 });
      if (value.trim() === '') {
        // Blank means unset: the default cap of 65 °C applies.
        expect(result.isError, JSON.stringify(value)).toBe(true);
        expect(result.text).toMatch(/limit of 65/);
      } else {
        expect(result.isError, value).toBe(true);
        expect(result.text).toMatch(/QIDI_MAX_CHAMBER_TEMP/);
      }
      expect(seen.some(s => s.path === '/printer/gcode/script')).toBe(false);
    }
  });

  it('refuses to start a print when QIDI_PLATE_CHECK_MAX_AGE_MIN is not a number', async () => {
    vi.stubEnv('QIDI_PLATE_CHECK_MAX_AGE_MIN', 'fifteen');
    const { call, seen } = await connect({ state: 'standby', filename: '', lastJobEnd: T0 / 1000 - 3600 }, now);
    await call('qidi_snapshot');
    time += 60 * 60_000;
    const result = await call('qidi_start_print', { filename: 'part.gcode', plateIsEmpty: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/QIDI_PLATE_CHECK_MAX_AGE_MIN/);
    expect(seen.some(s => s.path === '/printer/print/start')).toBe(false);
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

describe('numeric limits', () => {
  it('reads defaults and valid overrides', () => {
    expect(temperatureLimits({})).toEqual({ extruder: 300, heater_bed: 110, chamber: 65 });
    expect(temperatureLimits({ QIDI_MAX_NOZZLE_TEMP: '250', QIDI_MAX_BED_TEMP: '0' })).toMatchObject({
      extruder: 250,
      heater_bed: 0,
    });
    expect(plateCheckMaxAgeMs({})).toBe(15 * 60_000);
    expect(plateCheckMaxAgeMs({ QIDI_PLATE_CHECK_MAX_AGE_MIN: '5' })).toBe(5 * 60_000);
  });

  it('never yields NaN or out-of-range limits', () => {
    for (const [name, value] of [
      ['QIDI_MAX_NOZZLE_TEMP', 'abc'],
      ['QIDI_MAX_NOZZLE_TEMP', '300.5'],
      ['QIDI_MAX_NOZZLE_TEMP', '-1'],
      ['QIDI_MAX_NOZZLE_TEMP', '401'],
      ['QIDI_MAX_BED_TEMP', 'NaN'],
      ['QIDI_MAX_CHAMBER_TEMP', 'Infinity'],
      ['QIDI_PLATE_CHECK_MAX_AGE_MIN', '0'],
      ['QIDI_PLATE_CHECK_MAX_AGE_MIN', '15min'],
      ['QIDI_TIMEOUT_MS', '10s'],
    ] as const) {
      expect(() => validateQidiEnv({ [name]: value }), `${name}=${value}`).toThrow(ConfigError);
    }
    expect(() => validateQidiEnv({})).not.toThrow();
  });
});

describe('moonraker client safety', () => {
  it('does not follow redirects when an API key is configured', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_: unknown, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(null, { status: 302, headers: { location: 'http://elsewhere.example/' } });
    }) as unknown as typeof fetch;
    const client = new MoonrakerClient({ baseUrl: 'http://p:7125', apiKey: 'secret-key', fetchImpl });
    await expect(client.get('/server/info')).rejects.toThrow(/redirect/);
    await expect(client.snapshot()).rejects.toThrow(/redirect/);
    expect(inits.every(init => init.redirect === 'manual')).toBe(true);
  });

  it('follows a same-origin webcam redirect with the key, but not a cross-origin one', async () => {
    const calls: Array<{ url: string; key?: string }> = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, key: (init?.headers as Record<string, string> | undefined)?.['x-api-key'] });
      if (url === 'http://p/webcam?action=snapshot') {
        return new Response(null, { status: 301, headers: { location: '/webcam/?action=snapshot' } });
      }
      if (url === 'http://p/webcam/?action=snapshot') {
        return new Response(new Uint8Array([0xff, 0xd8]), { headers: { 'content-type': 'image/jpeg' } });
      }
      if (url === 'http://p/cross') {
        return new Response(null, { status: 302, headers: { location: 'http://elsewhere.example/img.jpg' } });
      }
      return new Response(null, { status: 302, headers: { location: url.replace(/\/(\d+)$/, (_m, n) => `/${Number(n) + 1}`) } });
    }) as unknown as typeof fetch;

    const ok = new MoonrakerClient({ baseUrl: 'http://p:7125', snapshotUrl: 'http://p/webcam?action=snapshot', apiKey: 'k', fetchImpl });
    const snap = await ok.snapshot();
    expect(snap.mimeType).toBe('image/jpeg');
    expect(calls.map(c => [c.url, c.key])).toEqual([
      ['http://p/webcam?action=snapshot', 'k'],
      ['http://p/webcam/?action=snapshot', 'k'],
    ]);

    calls.length = 0;
    const cross = new MoonrakerClient({ baseUrl: 'http://p:7125', snapshotUrl: 'http://p/cross', apiKey: 'k', fetchImpl });
    await expect(cross.snapshot()).rejects.toThrow(/redirect/);
    expect(calls.some(c => new URL(c.url).hostname === 'elsewhere.example')).toBe(false);

    calls.length = 0;
    const loop = new MoonrakerClient({ baseUrl: 'http://p:7125', snapshotUrl: 'http://p/hop/1', apiKey: 'k', fetchImpl });
    await expect(loop.snapshot()).rejects.toThrow(/redirect/);
    expect(calls).toHaveLength(3);
  });

  it('caps error bodies and redacts the API key before truncating', async () => {
    const fetchImpl = (async () =>
      new Response(`bad key secret-key-123 ${'x'.repeat(500_000)}`, { status: 500 })) as unknown as typeof fetch;
    const client = new MoonrakerClient({ baseUrl: 'http://p:7125', apiKey: 'secret-key-123', fetchImpl });
    const error = await client.get('/server/info').then(
      () => new Error('expected a rejection'),
      (caught: unknown) => caught as Error,
    );
    expect(error.message).not.toContain('secret-key-123');
    expect(error.message).toContain('[REDACTED]');
    expect(error.message.length).toBeLessThan(500);
  });

  it('rejects an invalid QIDI_TIMEOUT_MS', () => {
    vi.stubEnv('QIDI_TIMEOUT_MS', 'abc');
    try {
      expect(() => new MoonrakerClient({ baseUrl: 'http://p:7125' })).toThrow(/QIDI_TIMEOUT_MS/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
