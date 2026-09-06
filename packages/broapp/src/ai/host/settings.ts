/**
 * Where the AI layer's non-secret settings live.
 *
 * `<dataDir>/ai/settings.json` holds which provider and model the user chose
 * and where to reach them. It never holds the API key — that is
 * `secrets.ts` — and a test asserts the string does not appear in the file,
 * because "we do not write it there" is the kind of promise that quietly
 * stops being true.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The settings file's shape. `version` exists so a later format can migrate. */
export interface StoredSettings {
  version: 1;
  provider: string | null;
  modelId: string | null;
  baseUrl: string | null;
  /** False means the key is held in memory only and forgotten on exit. */
  remember: boolean;
}

/** Reads and writes {@link StoredSettings}. */
export interface SettingsStore {
  read(): StoredSettings;
  write(next: StoredSettings): void;
}

/** What a fresh installation has. No provider, so the layer is off. */
export function defaultSettings(): StoredSettings {
  return { version: 1, provider: null, modelId: null, baseUrl: null, remember: true };
}

function coerce(value: unknown): StoredSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | null => (typeof raw[key] === 'string' ? (raw[key] as string) : null);
  return {
    version: 1,
    provider: text('provider'),
    modelId: text('modelId'),
    baseUrl: text('baseUrl'),
    remember: raw['remember'] !== false,
  };
}

/** Open the settings store for one data directory. */
export function createSettingsStore(dataDir: string): SettingsStore {
  const directory = join(dataDir, 'ai');
  const file = join(directory, 'settings.json');
  const temporary = `${file}.tmp`;

  return {
    read() {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        // No file yet is the ordinary case on a first run, not a failure.
        return defaultSettings();
      }
      try {
        const parsed = coerce(JSON.parse(text) as unknown);
        if (parsed === null) throw new Error('not an object');
        return parsed;
      } catch {
        // A file the user or another tool mangled should not stop the
        // application from starting, and should not be deleted either — they
        // may want to repair it.
        console.warn(`[broapp] ignoring unreadable AI settings at ${file}`);
        return defaultSettings();
      }
    },

    write(next) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Written to a sibling and renamed, so a crash mid-write leaves the
      // previous settings intact rather than a truncated file.
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      renameSync(temporary, file);
    },
  };
}
