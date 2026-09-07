/**
 * What the browser does to an attachment before it is sent.
 *
 * Only the part that needs no pixels is tested here: `splitDataUrl` is where
 * an unacceptable file is turned into a sentence a person can act on.
 * `prepareImage`'s downscaling needs `createImageBitmap` and a canvas, which
 * `bun test` has neither of — prompt 04's manual run covers that path.
 */
import { describe, expect, test } from 'bun:test';

import { IMAGE_LIMITS, splitDataUrl } from 'broapp-ai-elements';

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
