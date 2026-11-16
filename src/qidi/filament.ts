/**
 * QIDI's filament list (officiall_filas_list.cfg on the printer) and the
 * drying limits derived from filament type.
 */

export interface FilamentEntry {
  /** Section name, e.g. fila7. */
  id: string;
  /** Product name as the printer and touchscreen show it, e.g. "PLA Basic". */
  name: string;
  /** Material family, e.g. PLA, PETG, ASA-CF. */
  type: string;
}

export interface FilamentList {
  filaments: FilamentEntry[];
  vendors: string[];
}

export const FILAMENT_LIST_FILE = 'officiall_filas_list.cfg';

/** Parse the INI-style list: [filaN] sections with filament/type keys, and [vendor_list]. */
export function parseFilamentList(text: string): FilamentList {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = {};
      sections.set(header[1]!.trim(), current);
      continue;
    }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (kv && current) current[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
  }

  const filaments: FilamentEntry[] = [];
  for (const [id, keys] of sections) {
    const name = keys.filament;
    if (!name) continue;
    filaments.push({ id, name, type: keys.type || name });
  }
  const vendors = Object.values(sections.get('vendor_list') ?? {}).filter(Boolean);
  return { filaments, vendors };
}

export function findFilament(list: FilamentList, material: string): FilamentEntry | undefined {
  const needle = normalise(material);
  return list.filaments.find(f => normalise(f.name) === needle);
}

export function findVendor(list: FilamentList, vendor: string): string | undefined {
  const needle = normalise(vendor);
  return list.vendors.find(v => normalise(v) === needle);
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Drying ceiling for material whose type is not recognised. */
export const UNKNOWN_FILAMENT_DRY_MAX = 50;

/**
 * Highest drying temperature for one filament type (°C), before the global
 * QIDI_MAX_BOX_DRY_TEMP ceiling. PLA softens around 55-60 °C, so PLA-family and
 * other low-temperature materials stop at 55; engineering materials may use the
 * Box's 65 °C. Anything unrecognised gets a conservative 50.
 */
export function dryMaxForType(type: string | undefined): number {
  const t = (type ?? '').trim().toUpperCase();
  if (!t) return UNKNOWN_FILAMENT_DRY_MAX;
  if (/^(PLA|PVA|TPU|TPE|PEBA|SUPPORT FOR PLA)/.test(t)) return 55;
  if (/^(PETG|PET|ABS|ASA|PC|PA|ULTRAPA|PPS|SUPPORT FOR P)/.test(t)) return 65;
  return UNKNOWN_FILAMENT_DRY_MAX;
}
