/**
 * Where the AI layer's non-secret settings live.
 *
 * `<dataDir>/ai/settings.json` holds which provider is in use, and for every
 * provider the person has set up, where to reach it, which model it runs and
 * whether it is turned on. It never holds an API key — that is `secrets.ts` —
 * and a test asserts the string does not appear in the file, because "we do
 * not write it there" is the kind of promise that quietly stops being true.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One provider's own settings, kept whether or not it is the one in use. */
export interface ProviderEntry {
  baseUrl: string | null;
  modelId: string | null;
  /**
   * Whether this provider may be sent anything. The provider in use always
   * is; any other only when a person turned it on, so a model reference in a
   * file cannot send their work somewhere they never chose.
   */
  enabled: boolean;
}

/**
 * The settings file's shape.
 *
 * Version 1 held one `provider`, `modelId` and `baseUrl`, so changing provider
 * lost the other's address and model. Version 2 keeps an entry per provider;
 * a version-1 file is read as version 2 and left as it is until the next write.
 */
export interface StoredSettings {
  version: 2;
  /** The provider a turn runs on when nothing names another. */
  active: string | null;
  /** False means every key is held in memory only and forgotten on exit. */
  remember: boolean;
  /**
   * Keyed by provider id. An entry for an id this build has no adapter for is
   * kept on write and ignored on read: another build may own it.
   */
  providers: Record<string, ProviderEntry>;
}

/** Reads and writes {@link StoredSettings}. */
export interface SettingsStore {
  read(): StoredSettings;
  write(next: StoredSettings): void;
}

/** What a fresh installation has. No provider, so the layer is off. */
export function defaultSettings(): StoredSettings {
  return { version: 2, active: null, remember: true, providers: {} };
}

function text(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' ? value : null;
}

/** A version-1 file, as version 2: the one provider it named, turned on. */
function fromVersion1(raw: Record<string, unknown>): StoredSettings {
  const active = text(raw, 'provider');
  return {
    version: 2,
    active,
    remember: raw['remember'] !== false,
    providers:
      active === null
        ? {}
        : { [active]: { baseUrl: text(raw, 'baseUrl'), modelId: text(raw, 'modelId'), enabled: true } },
  };
}

function coerce(value: unknown): StoredSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  // A file written before `version` existed, or by version 1, has the old shape.
  if (raw['version'] === undefined || raw['version'] === 1) return fromVersion1(raw);
  if (raw['version'] !== 2) return null;
  const listed = raw['providers'];
  if (typeof listed !== 'object' || listed === null || Array.isArray(listed)) return null;
  const providers: Record<string, ProviderEntry> = {};
  for (const [id, entry] of Object.entries(listed as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const fields = entry as Record<string, unknown>;
    providers[id] = {
      baseUrl: text(fields, 'baseUrl'),
      modelId: text(fields, 'modelId'),
      enabled: fields['enabled'] === true,
    };
  }
  return { version: 2, active: text(raw, 'active'), remember: raw['remember'] !== false, providers };
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
