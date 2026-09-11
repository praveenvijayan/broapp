/**
 * This package's version, for the record a case keeps of what built it.
 *
 * Read from the manifest rather than typed in, so a case says which launcher
 * met the failure even after the launcher has been upgraded.
 */
import manifest from '../../package.json' with { type: 'json' };

export const AUTOAPP_VERSION: string = manifest.version;
