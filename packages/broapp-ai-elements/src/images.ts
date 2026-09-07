/**
 * Turning what a person pasted into what the contract accepts.
 *
 * The work is done in the browser rather than on the host for one reason: a
 * phone photograph is several megabytes and almost none of those bytes reach
 * the model anyway — a provider downscales to about 1568 px on the longest
 * edge before it looks. Sending the original would pay for the upload twice
 * and buy nothing.
 */
import type { FileUIPart } from 'ai';

/** One image, ready for `ai.chat`. `data` is base64 with no `data:` prefix. */
export interface PreparedImage {
  readonly name: string;
  readonly mediaType: string;
  readonly data: string;
}

/** The bounds the contract, the provider and the panel all agree on. */
export const IMAGE_LIMITS = {
  maxFiles: 4,
  maxEdge: 1568,
  maxBase64: 2_000_000,
  accept: 'image/png,image/jpeg,image/gif,image/webp',
} as const satisfies {
  readonly maxFiles: 4;
  readonly maxEdge: 1568;
  readonly maxBase64: 2_000_000;
  readonly accept: 'image/png,image/jpeg,image/gif,image/webp';
};

/** What the contract's `mediaType` pattern accepts. */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Quality for anything re-encoded. High enough that text in a screenshot stays readable. */
const JPEG_QUALITY = 0.85;

/**
 * Split a data URL into the pieces `ai.chat` wants.
 *
 * Throws a plain `Error` whose message is a sentence a person can act on: the
 * caller shows it as the reason the turn was not sent.
 */
export function splitDataUrl(url: string, filename?: string): PreparedImage {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (match === null) throw new Error('That file could not be read.');
  const [, mediaType = '', base64, data = ''] = match;
  if (!ALLOWED.has(mediaType)) {
    throw new Error('Only PNG, JPEG, GIF and WebP images can be sent.');
  }
  if (base64 === undefined) throw new Error('That file could not be read.');
  if (data === '') throw new Error('That image is empty.');
  return { name: filename ?? `image.${mediaType.slice('image/'.length)}`, mediaType, data };
}

/** The base64 payload as bytes, without going near `fetch`. */
function bytesOf(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The image's pixel size, read from its header.
 *
 * Every format here writes its dimensions in the first few dozen bytes, and
 * reading them costs nothing — where decoding the image costs a canvas, a
 * decoder, and in some embedded browsers a failure. An image already small
 * enough is then sent exactly as it arrived.
 *
 * `null` means "this header was not understood", which is treated as "small
 * enough": the provider downscales for itself, and the contract's byte bound
 * still applies.
 */
export function intrinsicSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (index: number): number => bytes[index] ?? 0;

  // PNG: an 8-byte signature, then an IHDR chunk whose first two fields are
  // the dimensions, big-endian.
  if (bytes.length > 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: "GIF87a"/"GIF89a", then the logical screen size, little-endian.
  if (bytes.length > 10 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // JPEG: walk the markers to the start-of-frame, which carries the size.
  if (bytes.length > 4 && at(0) === 0xff && at(1) === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (at(offset) !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = at(offset + 1);
      // SOF0…SOF15, minus the four markers in that range that are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }

  // WebP: "RIFF"…"WEBP", then one of three chunk layouts.
  if (bytes.length > 30 && at(0) === 0x52 && at(8) === 0x57 && at(9) === 0x45) {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15));
    if (chunk === 'VP8 ') {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return {
        width: (at(24) | (at(25) << 8) | (at(26) << 16)) + 1,
        height: (at(27) | (at(28) << 8) | (at(29) << 16)) + 1,
      };
    }
  }
  return null;
}

/** A drawing surface, whichever one this browser has. */
interface Surface {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

/** `instanceof` would be false when the class is absent, which is the case to catch. */
function isOffscreen(canvas: OffscreenCanvas | HTMLCanvasElement): canvas is OffscreenCanvas {
  return typeof OffscreenCanvas === 'function' && canvas instanceof OffscreenCanvas;
}

function surface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('That image could not be resized.');
    return { canvas, context };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('That image could not be resized.');
  return { canvas, context };
}

/** The surface's contents as base64 JPEG, without the `data:` prefix. */
async function toJpegBase64(view: Surface): Promise<string> {
  const canvas = view.canvas;
  const blob = await (isOffscreen(canvas)
    ? canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    : new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) =>
            result === null
              ? reject(new Error('That image could not be resized.'))
              : resolve(result),
          'image/jpeg',
          JPEG_QUALITY,
        );
      }));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Downscale one attachment until it fits.
 *
 * A PNG, GIF or WebP already inside both limits passes through untouched, so a
 * small screenshot keeps its exact pixels. Anything else is redrawn and
 * re-encoded as JPEG, halving the longest edge again while the base64 is still
 * over the limit. **An animated GIF loses its animation**: only the first
 * frame is drawn, which is all a model reads of one anyway.
 */
export async function prepareImage(part: FileUIPart): Promise<PreparedImage> {
  const original = splitDataUrl(part.url, part.filename);
  const size = intrinsicSize(bytesOf(original.data));
  const edge = size === null ? 0 : Math.max(size.width, size.height);
  // Nothing to do, and nothing to decode: the common case is a screenshot that
  // is already small enough, and this is where it stays exactly as it arrived.
  if (original.data.length <= IMAGE_LIMITS.maxBase64 && edge <= IMAGE_LIMITS.maxEdge) {
    return original;
  }
  if (typeof createImageBitmap !== 'function') {
    throw new Error('That image is too large to send. Try a smaller one.');
  }
  const bitmap = await bitmapOf(original);
  try {
    return await redraw(bitmap, original.name, IMAGE_LIMITS.maxEdge);
  } finally {
    bitmap.close();
  }
}

/**
 * Decode a data URL into pixels.
 *
 * Built by hand rather than with `fetch(url)`: a Broapp page's policy is
 * `connect-src 'self' ws://127.0.0.1:*`, and a fetch of a `data:` URL is a
 * connection as far as that policy is concerned.
 */
async function bitmapOf(image: PreparedImage): Promise<ImageBitmap> {
  const binary = atob(image.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return createImageBitmap(new Blob([bytes], { type: image.mediaType }));
}

/** Draw at `edge` or smaller, halving until the encoded result fits. */
async function redraw(
  bitmap: ImageBitmap,
  name: string,
  edge: number,
): Promise<PreparedImage> {
  let limit = edge;
  for (;;) {
    const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const view = surface(width, height);
    view.context.drawImage(bitmap, 0, 0, width, height);
    const data = await toJpegBase64(view);
    if (data.length <= IMAGE_LIMITS.maxBase64 || width === 1 || height === 1) {
      return { name: jpegName(name), mediaType: 'image/jpeg', data };
    }
    limit = Math.max(1, Math.floor(limit / 2));
  }
}

/** The name the model is told, once the bytes are no longer what arrived. */
function jpegName(name: string): string {
  return /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, '')}.jpg`;
}
