import { expect, test } from 'bun:test';
import { BookOpen, Newspaper, Palette } from 'lucide-react';

import { glyphFor, hueFor, letterFor } from '../packages/broapp-autoapp/src/launcher/ui/AppIcon.tsx';

test('a name that says what it is gets that glyph; the id counts too', () => {
  expect(glyphFor('News', 'news')).toBe(Newspaper);
  expect(glyphFor('painting app', 'painting-app')).toBe(Palette);
  expect(glyphFor('Reading list', 'reading-list')).toBe(BookOpen);
  expect(glyphFor('Shelf', 'my-books')).toBe(BookOpen);
});

test('a name that says nothing gets its first letter', () => {
  expect(glyphFor('Zebra', 'zebra')).toBeNull();
  expect(glyphFor('Ready steady', 'ready-steady')).toBeNull();
  expect(letterFor('zebra', 'zebra')).toBe('Z');
  expect(letterFor('  ✨ éclair', 'eclair')).toBe('É');
  expect(letterFor('✨', 'x1')).toBe('X');
});

test('the hue is the same for the same id, within a circle', () => {
  expect(hueFor('news')).toBe(hueFor('news'));
  expect(hueFor('news')).not.toBe(hueFor('painting-app'));
  for (const id of ['a', 'news', 'reading-list', 'x'.repeat(200)]) {
    expect(hueFor(id)).toBeGreaterThanOrEqual(0);
    expect(hueFor(id)).toBeLessThan(360);
  }
});
