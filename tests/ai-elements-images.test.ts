/**
 * What the browser does to an attachment before it is sent.
 *
 * Only the part that needs no pixels is tested here: `splitDataUrl` is where
 * an unacceptable file is turned into a sentence a person can act on.
 * `prepareImage`'s downscaling needs `createImageBitmap` and a canvas, which
 * `bun test` has neither of — prompt 04's manual run covers that path.
 */
import { describe, expect, test } from 'bun:test';

import { IMAGE_LIMITS, intrinsicSize, prepareImage, splitDataUrl } from 'broapp-ai-elements';
import { settleForSubmit } from 'broapp-ai-elements/ui';

/** A one-pixel PNG, as `PromptInput` would hand it over. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('splitDataUrl', () => {
  test('splits a PNG data URL into name, media type and base64', () => {
    const image = splitDataUrl(PNG, 'shot.png');
    expect(image.name).toBe('shot.png');
    expect(image.mediaType).toBe('image/png');
    expect(image.data.startsWith('iVBORw0KGgo')).toBe(true);
  });

  test('names an image the picker did not name', () => {
    expect(splitDataUrl(PNG).name).toBe('image.png');
  });

  test('refuses a media type that is not a bitmap image', () => {
    expect(() => splitDataUrl('data:image/svg+xml;base64,PHN2Zy8+', 'logo.svg')).toThrow(
      'Only PNG, JPEG, GIF and WebP images can be sent.',
    );
    expect(() => splitDataUrl('data:text/plain;base64,aGk=', 'note.txt')).toThrow(
      'Only PNG, JPEG, GIF and WebP images can be sent.',
    );
  });

  test('refuses something that is not a data URL at all', () => {
    expect(() => splitDataUrl('https://example.com/cat.png', 'cat.png')).toThrow(
      'That file could not be read.',
    );
  });

  test('refuses an empty image', () => {
    expect(() => splitDataUrl('data:image/png;base64,', 'empty.png')).toThrow(
      'That image is empty.',
    );
  });

  test('trusts the data URL over the part it came on', () => {
    // The URL is what carries the bytes, so the media type on it is the one
    // the host is told about. A part claiming otherwise cannot smuggle an SVG
    // past the contract by calling itself a PNG.
    expect(splitDataUrl('data:image/jpeg;base64,AAAA', 'shot.png').mediaType).toBe('image/jpeg');
  });
});

/** The base64 payload of a data URL, as bytes. */
function bytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

describe('intrinsicSize', () => {
  test('reads a PNG header', () => {
    expect(intrinsicSize(bytes(PNG))).toEqual({ width: 1, height: 1 });
  });

  test('reads a GIF header', () => {
    // GIF89a, 3×2 logical screen.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0, 0]);
    expect(intrinsicSize(gif)).toEqual({ width: 3, height: 2 });
  });

  test('says nothing rather than guessing at an unknown header', () => {
    expect(intrinsicSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('prepareImage', () => {
  test('sends a small image exactly as it arrived', async () => {
    // No canvas and no decoder are needed for this path, which is the one a
    // pasted screenshot takes almost every time.
    const prepared = await prepareImage({
      type: 'file',
      mediaType: 'image/png',
      filename: 'shot.png',
      url: PNG,
    });
    expect(prepared).toEqual(splitDataUrl(PNG, 'shot.png'));
  });

  test('refuses an oversized image when the browser cannot decode', async () => {
    // `bun test` has no `createImageBitmap`, which is the case this covers:
    // downscaling is impossible, so the turn is refused with a sentence rather
    // than sent over the contract's bound.
    const huge = `data:image/png;base64,${'A'.repeat(2_000_004)}`;
    await expect(
      prepareImage({ type: 'file', mediaType: 'image/png', filename: 'big.png', url: huge }),
    ).rejects.toThrow('That image is too large to send. Try a smaller one.');
  });
});

describe('IMAGE_LIMITS', () => {
  test('matches what the contract accepts', () => {
    expect(IMAGE_LIMITS).toEqual({
      maxFiles: 4,
      maxEdge: 1568,
      maxBase64: 2_000_000,
      accept: 'image/png,image/jpeg,image/gif,image/webp',
    });
  });
});

describe('settleForSubmit', () => {
  /** An entry as `PromptInput` holds it, in the two states it can be in. */
  const done = (id: string) => ({ id, url: `data:image/png;base64,${id}` });
  const waiting = (id: string) => ({ id, pending: true, url: '' });

  test('waits for a read still running, and returns what it filled in', async () => {
    let entries = [done('a'), waiting('b')];
    const read = Promise.resolve().then(() => {
      entries = [done('a'), done('b')];
    });
    const ready = await settleForSubmit(() => entries, new Map([['b', read]]));
    expect(ready.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('a read that fails does not take the rest of the turn with it', async () => {
    // The failed read has already removed its own entry and said so; the
    // other image is still what the person attached.
    const entries = [done('a')];
    const failed = Promise.reject(new Error('unreadable'));
    const ready = await settleForSubmit(() => entries, new Map([['b', failed]]));
    expect(ready.map((entry) => entry.id)).toEqual(['a']);
  });

  test('a file removed while it was being read is not sent', async () => {
    let entries = [done('a'), waiting('b')];
    const read = Promise.resolve().then(() => {
      entries = [done('a')];
    });
    const ready = await settleForSubmit(() => entries, new Map([['b', read]]));
    expect(ready.map((entry) => entry.id)).toEqual(['a']);
  });

  test('with nothing pending it returns the complete entries only', async () => {
    const entries = [done('a'), waiting('b')];
    const ready = await settleForSubmit(() => entries, new Map());
    expect(ready.map((entry) => entry.id)).toEqual(['a']);
  });
});
