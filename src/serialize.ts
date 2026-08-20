/**
 * JSON-safe serialization of query results ("types to JSON" over the line).
 *
 * Map: bigint -> string (safe beyond 2^53), Date -> ISO string, binary ->
 * base64 string, array-of-bytes types -> base64 string, undefined / NaN /
 * Infinity / other exotic values -> null. Nested containers are converted
 * recursively.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toBase64(buffer: Uint8Array): string {
  const bytes = Array.from(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.slice(i, i + 0x8000);
    out += String.fromCharCode(...chunk);
  }
  return Buffer.from(out, 'binary').toString('base64');
}

/** Convert one engine value to a JSON-safe value. */
export function serializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (t === 'bigint') {
    // Keep exactness: a plain number would lose precision past 2^53.
    return v.toString();
  }
  if (t === 'string' || t === 'boolean') return v;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  }
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    return toBase64(v instanceof Uint8Array ? v : new Uint8Array(v));
  }
  if (ArrayBuffer.isView(v)) {
    return toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  if (Array.isArray(v)) return v.map(serializeValue);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v)) out[key] = serializeValue(val);
    return out;
  }
  return null;
}

/** Cap an already-materialized row array at `maxRows`. */
export function capRows<T>(rows: T[], maxRows?: number): { rows: T[]; truncated: boolean } {
  const max = maxRows === undefined || !Number.isFinite(maxRows) || maxRows < 0
    ? Infinity
    : Math.floor(maxRows);
  if (rows.length <= max) return { rows, truncated: false };
  return { rows: rows.slice(0, max), truncated: true };
}
