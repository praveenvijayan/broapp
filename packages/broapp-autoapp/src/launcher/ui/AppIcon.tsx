/**
 * An application's icon, chosen for it: a glyph for what its name says it is,
 * else its first letter, on a tile whose hue comes from its id. Nobody picks
 * it yet; the same application always gets the same icon.
 */
import {
  BookOpen,
  Calendar,
  CheckSquare,
  ChefHat,
  CloudSun,
  Dumbbell,
  Film,
  Gamepad2,
  Image as ImageIcon,
  Map as MapIcon,
  MessageSquare,
  Music,
  Newspaper,
  NotebookPen,
  Palette,
  ShoppingCart,
  Timer,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';

/** Words in a name, and the glyph they mean. First match wins. */
const GLYPHS: readonly (readonly [RegExp, LucideIcon])[] = [
  [/\b(news|feed|article|blog|headline)/, Newspaper],
  [/\b(paint|draw|sketch|canvas|colou?r)/, Palette],
  [/\b(reading|read\b|book|librar)/, BookOpen],
  [/\b(note|journal|diary|memo)/, NotebookPen],
  [/\b(shop|cart|grocer|store|buy)/, ShoppingCart],
  [/\b(todo|to-do|task|check|habit)/, CheckSquare],
  [/\b(image|photo|picture|background|gallery)/, ImageIcon],
  [/\b(music|song|playlist|audio)/, Music],
  [/\b(movie|film|video|watch)/, Film],
  [/\b(recipe|food|cook|meal)/, ChefHat],
  [/\b(calendar|event|schedul|plan)/, Calendar],
  [/\b(money|budget|expense|finance|wallet)/, Wallet],
  [/\b(chat|message|mail)/, MessageSquare],
  [/\b(weather|forecast)/, CloudSun],
  [/\b(fitness|workout|gym|exercise|running|run\b)/, Dumbbell],
  [/\b(game|puzzle|quiz)/, Gamepad2],
  [/\b(map|travel|trip|place)/, MapIcon],
  [/\b(timer|clock|pomodoro)/, Timer],
];

/** The glyph an application's name or id asks for, or `null` for a letter. */
export function glyphFor(name: string, appId: string): LucideIcon | null {
  const words = `${name} ${appId.replace(/[-_]/g, ' ')}`.toLowerCase();
  return GLYPHS.find(([pattern]) => pattern.test(words))?.[1] ?? null;
}

/** The letter on a tile with no glyph. */
export function letterFor(name: string, appId: string): string {
  return (/[\p{L}\p{N}]/u.exec(name) ?? /[\p{L}\p{N}]/u.exec(appId))?.[0]?.toUpperCase() ?? '?';
}

/** A hue from 0 to 359, the same for the same id. */
export function hueFor(appId: string): number {
  let hash = 0;
  for (const char of appId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

export function AppIcon({ appId, name, size = 'medium' }: { readonly appId: string; readonly name: string; readonly size?: 'small' | 'medium' }): ReactElement {
  const Glyph = glyphFor(name, appId);
  return (
    <span aria-hidden="true" className={`launcher__app-icon launcher__app-icon--${size}`} style={{ ['--app-hue' as string]: String(hueFor(appId)) }}>
      {Glyph === null ? letterFor(name, appId) : <Glyph strokeWidth={2} />}
    </span>
  );
}
