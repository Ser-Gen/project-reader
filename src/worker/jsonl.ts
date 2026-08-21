/**
 * Byte-level incremental JSONL splitter.
 *
 * We deliberately do NOT use TextDecoderStream + string splitting: we need exact
 * byte offsets so an over-sized record can be re-read later with file.slice()
 * instead of being retained in memory. Newlines are safe split points in UTF-8
 * (0x0A never appears inside a multi-byte sequence), so decoding line-by-line is
 * correct.
 */

export interface RawLine {
  text: string;
  /** absolute byte offset of the first byte of the line */
  start: number;
  /** absolute byte offset one past the last byte (excluding the newline) */
  end: number;
  lineNo: number;
}

const NL = 0x0a;

export async function* streamLines(
  file: Blob,
  onProgress?: (bytesRead: number) => void,
): AsyncGenerator<RawLine> {
  const decoder = new TextDecoder('utf-8');
  const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();

  // Carry holds the tail of the previous chunk when a line straddles a boundary.
  let carry: Uint8Array | null = null;
  let carryStart = 0;
  let absolute = 0;
  let lineNo = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      let searchFrom = 0;

      for (;;) {
        const nl = chunk.indexOf(NL, searchFrom);
        if (nl === -1) break;

        let start: number;
        let text: string;
        if (carry) {
          const head = chunk.subarray(searchFrom, nl);
          const joined = new Uint8Array(carry.length + head.length);
          joined.set(carry, 0);
          joined.set(head, carry.length);
          text = decoder.decode(joined);
          start = carryStart;
          carry = null;
        } else {
          text = decoder.decode(chunk.subarray(searchFrom, nl));
          start = absolute + searchFrom;
        }
        const end = absolute + nl;
        searchFrom = nl + 1;
        if (text.length > 0) yield { text, start, end, lineNo: ++lineNo };
      }

      const restLen = chunk.length - searchFrom;
      if (restLen > 0) {
        const rest = chunk.subarray(searchFrom);
        if (carry) {
          const joined: Uint8Array = new Uint8Array(carry.length + rest.length);
          joined.set(carry, 0);
          joined.set(rest, carry.length);
          carry = joined;
        } else {
          carry = rest.slice(); // copy: the chunk buffer may be recycled
          carryStart = absolute + searchFrom;
        }
      }

      absolute += chunk.length;
      onProgress?.(absolute);
    }

    if (carry && carry.length) {
      const text = decoder.decode(carry);
      if (text.trim().length) {
        yield { text, start: carryStart, end: carryStart + carry.length, lineNo: ++lineNo };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Re-read one record by byte range. Used for bodies too big to keep in memory. */
export async function readLine(file: Blob, start: number, end: number): Promise<string> {
  const buf = await file.slice(start, end).arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}
