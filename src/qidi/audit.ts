import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface AuditEvent {
  actingAs?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  /** Tool arguments. Printer arguments carry no personal data (file names, temperatures), so they are logged as-is. */
  args?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
}

/**
 * Moonraker records every job as `_TRUSTED_USER_`, so this log is the only
 * record of who started, paused or cancelled a print from Claude.
 */
export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  const auditPath = process.env.QIDI_AUDIT_LOG;
  if (!auditPath) return;

  const record = {
    timestamp: new Date().toISOString(),
    actingAs: event.actingAs,
    tool: event.tool,
    action: event.action,
    args: event.args,
    status: event.status,
    reason: event.reason,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}
