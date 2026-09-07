/**
 * Turning a value into text.
 *
 * Four formats and nothing else. A view specification cannot supply a format
 * string, a locale or a pattern, because each of those is a small language and
 * a small language is a thing an engineer could put arbitrary behaviour into.
 * What a person actually needs from a local application is that a date reads as
 * a date in their own locale, and that is what `datetime` does.
 */
import type { Format } from '../views/types.ts';

/** What an absent value looks like. Not "undefined", and not blank either. */
const NOTHING = '—';

/** Render one value as text, for display only. */
export function formatValue(value: unknown, format: Format = 'text'): string {
  if (value === null || value === undefined) return NOTHING;
  switch (format) {
    case 'number': {
      const asNumber = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(asNumber) ? asNumber.toLocaleString() : NOTHING;
    }
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : NOTHING;
    case 'datetime': {
      // Milliseconds since the epoch is what every Broapp timestamp is, and a
      // string is accepted so a contract that stores ISO text still renders.
      const at = typeof value === 'number' ? new Date(value) : new Date(String(value));
      return Number.isNaN(at.getTime()) ? NOTHING : at.toLocaleString();
    }
    case 'text':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      // An object in a text cell is an authoring mistake, but showing its JSON
      // is more useful than showing "[object Object]" and safer than guessing.
      return JSON.stringify(value) ?? NOTHING;
  }
}
