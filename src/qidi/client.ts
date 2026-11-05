import { MoonrakerHttpError } from '../errors.js';

export interface MoonrakerClientOptions {
  /** Moonraker base URL, e.g. http://printer.lan:7125 */
  baseUrl?: string;
  /** Webcam snapshot URL (mjpeg-streamer), e.g. http://printer.lan/webcam/?action=snapshot */
  snapshotUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface Snapshot {
  data: Buffer;
  mimeType: string;
}

/**
 * Thin client for the printer's Moonraker API. Moonraker on the QIDI Plus5
 * trusts every LAN client, so there is no credential here: the only thing
 * that keeps the printer private is the network path (WireGuard, scoped to
 * the printer's address) and the gateway in front of this server.
 */
export class MoonrakerClient {
  readonly baseUrl: string;
  readonly snapshotUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoonrakerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.QIDI_MOONRAKER_URL ?? 'http://localhost:7125').replace(/\/+$/, '');
    this.snapshotUrl =
      options.snapshotUrl ?? process.env.QIDI_SNAPSHOT_URL ?? `${new URL(this.baseUrl).origin.replace(/:\d+$/, '')}/webcam/?action=snapshot`;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.QIDI_TIMEOUT_MS ?? 10_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async post<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>('POST', path, query);
  }

  /** Query printer objects; `objects` maps object name → attributes (empty = all). */
  async queryObjects(objects: Record<string, string[] | null>): Promise<Record<string, Record<string, unknown>>> {
    const params = Object.entries(objects)
      .map(([name, attrs]) => (attrs?.length ? `${encodeURIComponent(name)}=${attrs.map(encodeURIComponent).join(',')}` : encodeURIComponent(name)))
      .join('&');
    const result = await this.request<{ status: Record<string, Record<string, unknown>> }>('GET', `/printer/objects/query?${params}`);
    return result.status ?? {};
  }

  /** Run a G-code command. Only called with commands built from validated, enumerated input. */
  async gcode(script: string): Promise<unknown> {
    return this.post('/printer/gcode/script', { script });
  }

  async snapshot(): Promise<Snapshot> {
    const response = await this.fetchImpl(this.snapshotUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) {
      throw new MoonrakerHttpError(response.status, 'webcam snapshot', await response.text().catch(() => ''));
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    if (!mimeType.startsWith('image/')) {
      throw new Error(`Webcam returned ${mimeType}, not an image`);
    }
    return { data: Buffer.from(await response.arrayBuffer()), mimeType };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url, {
      method,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      // keep text
    }
    if (!response.ok) {
      throw new MoonrakerHttpError(response.status, path, payload);
    }
    return (payload as { result?: T } | undefined)?.result as T;
  }
}
