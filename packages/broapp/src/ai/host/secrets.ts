/**
 * Where the API key lives.
 *
 * `<dataDir>/ai/secrets.json` is a plain file, owned by the user, with mode
 * 0600 — the same posture as `~/.aws/credentials` and `~/.npmrc`. It is not
 * encrypted. What it protects against is another *user* on the machine and a
 * backup that copies world-readable files. What it does not protect against is
 * another process running as the same user: that process can read the file,
 * and no scheme that runs unattended on the same account can prevent it.
 *
 * A user who does not want the key on disk can turn `remember` off, and the
 * key is kept in memory for the life of the process instead.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A place to keep secrets by name. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The secret name the layer uses for a provider's key. */
export function apiKeySecretName(providerId: string): string {
  return `provider:${providerId}:apiKey`;
}

/** A store that forgets everything when the process exits. */
export function createMemorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    get: (name) => Promise.resolve(values.get(name) ?? null),
    set: (name, value) => {
      values.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      values.delete(name);
      return Promise.resolve();
    },
  };
}

interface StoredSecrets {
  version: 1;
  secrets: Record<string, string>;
}

/** A store backed by `<dataDir>/ai/secrets.json`. */
export function createFileSecretStore(dataDir: string): SecretStore {
  const directory = join(dataDir, 'ai');
  const file = join(directory, 'secrets.json');
  const temporary = `${file}.tmp`;
  let warned = false;

  function read(): StoredSecrets {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { version: 1, secrets: {} };
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      const secrets = (parsed as { secrets?: unknown }).secrets;
      if (typeof secrets !== 'object' || secrets === null) throw new Error('no secrets');
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof value === 'string') out[name] = value;
      }
      return { version: 1, secrets: out };
    } catch {
      // Warned once: a corrupt file would otherwise print on every read, and
      // the layer reads settings often.
      if (!warned) {
        warned = true;
        console.warn(`[broapp] ignoring unreadable AI secrets at ${file}`);
      }
      return { version: 1, secrets: {} };
    }
  }

  function write(next: StoredSecrets): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows has no POSIX mode bits. The call is made anyway so that every
      // platform that does have them gets them, and the one that does not is
      // not a special case in the caller.
    }
  }

  return {
    get: (name) => Promise.resolve(read().secrets[name] ?? null),
    set: (name, value) => {
      const current = read();
      write({ version: 1, secrets: { ...current.secrets, [name]: value } });
      return Promise.resolve();
    },
    delete: (name) => {
      const current = read();
      if (!(name in current.secrets)) return Promise.resolve();
      const { [name]: _removed, ...rest } = current.secrets;
      if (Object.keys(rest).length === 0) {
        // An empty file is worse than none: it still says a key was here.
        rmSync(file, { force: true });
        return Promise.resolve();
      }
      write({ version: 1, secrets: rest });
      return Promise.resolve();
    },
  };
}
