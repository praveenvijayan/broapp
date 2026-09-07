/**
 * The six messages a launcher and an application child exchange.
 *
 * There are six and there will not quietly be a seventh: the set is small
 * enough to reason about, and every one of them is about the child's lifecycle
 * rather than about the application's work. An application's operations never
 * travel this channel — the launcher supervises, it does not proxy.
 *
 * Every message carries `v`. A child built by a different release of the
 * launcher is a real possibility once candidate releases exist, and a version
 * mismatch has to be a refusal rather than a field that happens to be missing.
 */

/** The only protocol version there is. */
export const IPC_VERSION = 1 as const;

/** What every message carries. */
interface Base {
  readonly v: typeof IPC_VERSION;
  /** Unique per message. A reply carries the request's id in `re`. */
  readonly id: string;
  readonly re?: string;
}

/** Child → launcher, first message, within `helloTimeoutMs` of spawn. */
export interface Hello extends Base {
  readonly type: 'hello';
  readonly appId: string;
  readonly releaseId: string;
  readonly pid: number;
}

/** Child → launcher, when its bridge is bound and serving. */
export interface Ready extends Base {
  readonly type: 'ready';
  /** The launch URL, token included. Never persisted by the launcher. */
  readonly url: string;
  readonly schemaVersion: number;
}

/** Launcher → child request, and child → launcher reply with the same type and `re`. */
export interface Health extends Base {
  readonly type: 'health';
  readonly state?: 'starting' | 'serving' | 'draining' | 'stopping';
  readonly activeWork?: number;
  readonly attached?: boolean;
}

/** Launcher → child: stop admitting new work; reply when `activeWork` is 0 or the deadline passes. */
export interface Drain extends Base {
  readonly type: 'drain';
  readonly deadlineMs: number;
  readonly drained?: boolean;
}

/** Launcher → child: exit cleanly within the deadline or be killed. */
export interface Shutdown extends Base {
  readonly type: 'shutdown';
  readonly deadlineMs: number;
}

/** Child → launcher: something unrecoverable; the child exits after sending. */
export interface Fatal extends Base {
  readonly type: 'fatal';
  /** One sentence, no stack, no secret. */
  readonly reason: string;
}

/** Anything that may legitimately cross the channel. */
export type Message = Hello | Ready | Health | Drain | Shutdown | Fatal;

/**
 * The most a single message may weigh.
 *
 * A lifecycle message is a handful of short fields. A bound is here so that a
 * child which starts sending something else — a stack, a log, a document —
 * fails loudly at the channel instead of filling the launcher's heap.
 */
export const MAX_MESSAGE_BYTES = 16_384;
