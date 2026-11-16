import { MoonrakerHttpError } from '../errors.js';
import { requestTimeoutMs } from './policy.js';

/** Error bodies are read up to this many bytes. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Redirect hops followed for the webcam snapshot (e.g. `/webcam?x` -> `/webcam/?x`). */
const MAX_SNAPSHOT_REDIRECTS = 2;

export interface MoonrakerClientOptions {
  /** Moonraker base URL, e.g. http://printer.lan:7125 */
  baseUrl?: string;
  /** Webcam snapshot URL (mjpeg-streamer), e.g. http://printer.lan/webcam/?action=snapshot */
  snapshotUrl?: string;
  /** Moonraker API key, sent as X-Api-Key. Needed once the printer no longer trusts our address range. */
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface Snapshot {
  data: Buffer;
  mimeType: string;
}

/**
 * Thin client for the printer's Moonraker API. Moonraker on the QIDI Plus5
 * trusts every LAN client by default, so unless QIDI_MOONRAKER_API_KEY is set
 * the printer's privacy rests on the network path and on whatever
 * authenticates callers in front of this server.
 */
export class MoonrakerClient {
  readonly baseUrl: string;
  readonly snapshotUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoonrakerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.QIDI_MOONRAKER_URL ?? 'http://localhost:7125').replace(/\/+$/, '');
    this.snapshotUrl =
      options.snapshotUrl ?? process.env.QIDI_SNAPSHOT_URL ?? `${new URL(this.baseUrl).origin.replace(/:\d+$/, '')}/webcam/?action=snapshot`;
    this.apiKey = options.apiKey ?? (process.env.QIDI_MOONRAKER_API_KEY || undefined);
    this.timeoutMs = options.timeoutMs ?? requestTimeoutMs();
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
    const signal = AbortSignal.timeout(this.timeoutMs);
    let url = new URL(this.snapshotUrl);
    let response: Response;
    // Redirects are followed by hand: at most MAX_SNAPSHOT_REDIRECTS hops, and with an
    // API key only on the same origin, so the key is never sent to another host.
    for (let hops = 0; ; hops += 1) {
      response = await this.fetchImpl(url, {
        headers: this.apiKey ? { 'x-api-key': this.apiKey } : {},
        redirect: 'manual',
        signal,
      });
      if (!isRedirect(response.status)) {
        break;
      }
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      let next: URL | undefined;
      try {
        next = location ? new URL(location, url) : undefined;
      } catch {
        next = undefined;
      }
      if (
        !next ||
        (next.protocol !== 'http:' && next.protocol !== 'https:') ||
        hops >= MAX_SNAPSHOT_REDIRECTS ||
        (this.apiKey && next.origin !== url.origin)
      ) {
        throw new Error(
          `webcam snapshot responded with a redirect (HTTP ${response.status}) that is not followed ` +
            `(only ${MAX_SNAPSHOT_REDIRECTS} hops${this.apiKey ? ' on the same origin' : ''} are)`,
        );
      }
      url = next;
    }
    if (!response.ok) {
      const body = await readTextUpTo(response, MAX_ERROR_BODY_BYTES).catch(() => '');
      throw new MoonrakerHttpError(response.status, 'webcam snapshot', this.redact(body));
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
      headers: { accept: 'application/json', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
      // Never follow redirects: X-Api-Key would be re-sent to the redirect target.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.assertNotRedirect(response, path);
    // Error bodies are capped, and the API key is redacted before the error text is truncated.
    const text = response.ok ? await response.text() : this.redact(await readTextUpTo(response, MAX_ERROR_BODY_BYTES));
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

  private assertNotRedirect(response: Response, what: string): void {
    if (isRedirect(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`${what.split('?')[0]} responded with a redirect (HTTP ${response.status}); redirects are not followed`);
    }
  }

  /** Removes the configured API key from upstream text. */
  private redact(text: string): string {
    return this.apiKey && this.apiKey.length >= 4 ? text.split(this.apiKey).join('[REDACTED]') : text;
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

async function readTextUpTo(response: Response, limit: number): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks).toString('utf8');
}
