/**
 * Base64 image blocks -> Blob object URLs, entirely inside the worker.
 *
 * This is the single most important memory decision in the app: the example
 * transcript is 5.7 MB and ~5 MB of that is a dozen base64 PNGs. Turning them
 * into Blobs here means the main thread only ever sees a short `blob:` URL, the
 * bytes stay off the JS heap, and the DOM never holds a megabyte-long attribute.
 */

import type { ImageRef } from '../model/canon.js';

/** Decode base64 without building an intermediate 1.5x-size string per call. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const urls: string[] = [];

async function toRef(data: string, mime: string): Promise<ImageRef | null> {
  try {
    const bytes = b64ToBytes(data);
    const blob = new Blob([bytes as BlobPart], { type: mime || 'image/png' });
    let w = 0;
    let h = 0;
    try {
      const bmp = await createImageBitmap(blob);
      w = bmp.width;
      h = bmp.height;
      bmp.close();
    } catch {
      /* dimensions are an optimization, not a requirement */
    }
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return { url, w, h, bytes: bytes.length };
  } catch {
    return null;
  }
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

/**
 * Walk a record's content blocks, converting every base64 image in place and
 * dropping the base64 string so it can be collected immediately.
 * Returns the number of images converted.
 *
 * The *decoding* is shared; the *walking* is not, because each vendor buries
 * its images somewhere else. Claude nests them inside tool-result blocks;
 * Codex puts them straight in a message's content as data: URLs.
 */
export async function extractImages(rec: any): Promise<number> {
  const claude = rec?.message?.content;
  if (Array.isArray(claude)) return fromClaude(claude);
  const payload = rec?.payload;
  if (Array.isArray(payload?.content)) return fromCodex(payload.content);
  if (Array.isArray(payload?.output)) return fromCodex(payload.output);
  return 0;
}

async function fromClaude(content: any[]): Promise<number> {
  let n = 0;
  for (const block of content) {
    const inner = block?.content;
    if (!Array.isArray(inner)) continue;
    for (const part of inner) {
      if (part?.type !== 'image') continue;
      const src = part.source;
      if (src?.type === 'base64' && typeof src.data === 'string') {
        const ref = await toRef(src.data, src.media_type);
        src.data = ''; // release the big string right away
        if (ref) {
          part.__img = ref;
          n++;
        }
      } else if (typeof src?.url === 'string') {
        part.__img = { url: src.url, w: 0, h: 0, bytes: 0 } satisfies ImageRef;
        n++;
      }
    }
  }
  return n;
}

async function fromCodex(content: any[]): Promise<number> {
  let n = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (!/image/.test(String(part.type ?? ''))) continue;
    const url = part.image_url ?? part.url;
    if (typeof url !== 'string' || !url) continue;
    const m = DATA_URL.exec(url);
    if (m && m[2]) {
      const ref = await toRef(m[3], m[1] ?? 'image/png');
      part.image_url = ''; // release the big string right away
      if (ref) {
        part.__img = ref;
        n++;
      }
    } else if (!m) {
      part.__img = { url, w: 0, h: 0, bytes: 0 } satisfies ImageRef;
      n++;
    }
  }
  return n;
}

/** Called when a session is closed so the Blobs can be freed. */
export function revokeAll(): void {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.length = 0;
}
