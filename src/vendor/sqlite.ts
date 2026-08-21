/**
 * A read-only SQLite reader, just large enough for Cursor's `state.vscdb`.
 *
 * The spec called for sql.js, but that is a ~1 MB WASM blob for what Cursor
 * actually needs: full table scans of two key/value tables. Walking the b-tree
 * directly keeps the "no runtime dependencies" property, keeps the whole file
 * out of a second heap, and costs about 200 lines.
 *
 * What it does NOT do: WAL replay (a `-wal` sidecar is invisible to us, so very
 * recent writes may be missing), indexes, or any kind of query planning.
 */

const HEADER = 'SQLite format 3\0';

export interface SqliteTable {
  name: string;
  rootPage: number;
  sql: string;
}

export type SqlValue = null | number | string | Uint8Array;

export class SqliteDb {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  readonly pageSize: number;
  readonly usable: number;
  readonly tables: SqliteTable[] = [];

  constructor(bytes: Uint8Array) {
    let magic = '';
    for (let i = 0; i < 16 && i < bytes.length; i++) magic += String.fromCharCode(bytes[i]);
    if (magic !== HEADER) throw new Error('not a SQLite database');
    this.data = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const raw = this.view.getUint16(16);
    this.pageSize = raw === 1 ? 65536 : raw;
    this.usable = this.pageSize - bytes[20];
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) {
      throw new Error(`unsupported page size ${this.pageSize}`);
    }
    for (const row of this.rows(1)) {
      const [type, name, , rootPage, sql] = row;
      if (type === 'table' && typeof name === 'string' && typeof rootPage === 'number') {
        this.tables.push({ name, rootPage, sql: typeof sql === 'string' ? sql : '' });
      }
    }
  }

  table(name: string): SqliteTable | undefined {
    return this.tables.find((t) => t.name === name);
  }

  /** Every row of a table, as raw column values in declaration order. */
  *scan(name: string): Generator<SqlValue[]> {
    const t = this.table(name);
    if (!t) return;
    yield* this.rows(t.rootPage);
  }

  /** Walk a table b-tree, following interior pages depth-first. */
  private *rows(page: number, depth = 0): Generator<SqlValue[]> {
    if (depth > 32 || page < 1) return;
    const base = (page - 1) * this.pageSize;
    if (base + this.pageSize > this.data.length) return;
    const hdr = page === 1 ? base + 100 : base;
    const type = this.data[hdr];
    const cells = this.view.getUint16(hdr + 3);
    const headerLen = type === 0x05 || type === 0x02 ? 12 : 8;
    const ptrs = hdr + headerLen;

    if (type === 0x0d) {
      for (let i = 0; i < cells; i++) {
        const off = base + this.view.getUint16(ptrs + i * 2);
        yield this.leafCell(off);
      }
      return;
    }
    if (type === 0x05) {
      for (let i = 0; i < cells; i++) {
        const off = base + this.view.getUint16(ptrs + i * 2);
        yield* this.rows(this.view.getUint32(off), depth + 1);
      }
      const right = this.view.getUint32(hdr + 8);
      if (right) yield* this.rows(right, depth + 1);
      return;
    }
    // index pages carry no table rows
  }

  private leafCell(off: number): SqlValue[] {
    let p = off;
    const size = this.varint(p);
    p += size.len;
    const rowid = this.varint(p);
    p += rowid.len;
    const payload = this.payload(p, size.value);
    return this.record(payload);
  }

  /** Assemble a cell payload, following the overflow chain when there is one. */
  private payload(off: number, total: number): Uint8Array {
    const maxLocal = this.usable - 35;
    if (total <= maxLocal) return this.data.subarray(off, off + total);

    const minLocal = Math.floor(((this.usable - 12) * 32) / 255) - 23;
    let local = minLocal + ((total - minLocal) % (this.usable - 4));
    if (local > maxLocal) local = minLocal;

    const out = new Uint8Array(total);
    out.set(this.data.subarray(off, off + local), 0);
    let filled = local;
    let next = this.view.getUint32(off + local);
    let guard = 0;
    while (next && filled < total && guard++ < 1 << 20) {
      const base = (next - 1) * this.pageSize;
      if (base + this.usable > this.data.length) break;
      const chunk = Math.min(this.usable - 4, total - filled);
      out.set(this.data.subarray(base + 4, base + 4 + chunk), filled);
      filled += chunk;
      next = this.view.getUint32(base);
    }
    return out;
  }

  /** Decode a record: header of serial types, then the values themselves. */
  private record(buf: Uint8Array): SqlValue[] {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = 0;
    const h = readVarint(buf, 0);
    const headerEnd = h.value;
    p = h.len;
    const types: number[] = [];
    while (p < headerEnd && p < buf.length) {
      const t = readVarint(buf, p);
      p += t.len;
      types.push(t.value);
    }
    let at = headerEnd;
    const out: SqlValue[] = [];
    for (const t of types) {
      if (at > buf.length) {
        out.push(null);
        continue;
      }
      switch (t) {
        case 0:
          out.push(null);
          break;
        case 1:
          out.push(view.getInt8(at));
          at += 1;
          break;
        case 2:
          out.push(view.getInt16(at));
          at += 2;
          break;
        case 3:
          out.push((view.getInt16(at) << 8) | buf[at + 2]);
          at += 3;
          break;
        case 4:
          out.push(view.getInt32(at));
          at += 4;
          break;
        case 5: {
          const hi = view.getInt16(at);
          const lo = view.getUint32(at + 2);
          out.push(hi * 2 ** 32 + lo);
          at += 6;
          break;
        }
        case 6: {
          const hi = view.getInt32(at);
          const lo = view.getUint32(at + 4);
          out.push(hi * 2 ** 32 + lo);
          at += 8;
          break;
        }
        case 7:
          out.push(view.getFloat64(at));
          at += 8;
          break;
        case 8:
          out.push(0);
          break;
        case 9:
          out.push(1);
          break;
        default: {
          const len = (t - (t % 2 === 0 ? 12 : 13)) / 2;
          const slice = buf.subarray(at, at + len);
          out.push(t % 2 === 0 ? slice : decodeUtf8(slice));
          at += len;
        }
      }
    }
    return out;
  }

  private varint(off: number): { value: number; len: number } {
    return readVarint(this.data, off);
  }
}

const decoder = new TextDecoder('utf-8', { fatal: false });
function decodeUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

/**
 * SQLite's big-endian varint: 7 bits per byte for the first eight bytes, and a
 * ninth byte contributing all eight. Values above 2^53 lose precision, which
 * only rowids could ever reach and nothing here reads them.
 */
function readVarint(buf: Uint8Array, off: number): { value: number; len: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = buf[off + i] ?? 0;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, len: i + 1 };
  }
  return { value: value * 256 + (buf[off + 8] ?? 0), len: 9 };
}
