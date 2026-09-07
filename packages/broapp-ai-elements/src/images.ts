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
  if (typeof createImageBitmap !== 'function') {
    // No decoder — a test runner, or a browser old enough not to have one.
    // The contract's bound still holds, and every provider downscales for
    // itself, so an image already inside the bound is sent as it arrived
    // rather than refused for want of a canvas.
    if (original.data.length <= IMAGE_LIMITS.maxBase64) return original;
    throw new Error('That image is too large to send. Try a smaller one.');
  }
  if (original.data.length <= IMAGE_LIMITS.maxBase64) {
    const bitmap = await bitmapOf(part.url);
    try {
      if (Math.max(bitmap.width, bitmap.height) <= IMAGE_LIMITS.maxEdge) return original;
      return await redraw(bitmap, original.name, IMAGE_LIMITS.maxEdge);
    } finally {
      bitmap.close();
    }
  }
  const bitmap = await bitmapOf(part.url);
  try {
    return await redraw(bitmap, original.name, IMAGE_LIMITS.maxEdge);
  } finally {
    bitmap.close();
  }
}

/** Decode a data URL into pixels. */
async function bitmapOf(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  return createImageBitmap(await response.blob());
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
