/**
 * The messages a launcher and an application child exchange.
 *
 * There are eight and there will not quietly be a ninth: the set is small
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

/**
 * Launcher → child request, and child → launcher reply with the same type and `re`.
 *
 * Sent to a child started in migrate mode, which never serves anything. The
 * reply says where the data started and where it ended up, so an activation can
 * record what actually happened rather than what was expected to.
 */
export interface Migrate extends Base {
  readonly type: 'migrate';
  readonly dataDir: string;
  readonly from?: number;
  readonly to?: number;
}

/**
 * Launcher → child request, and child → launcher reply with the same type and `re`.
 *
 * One operation call, forwarded from an MCP client. The child runs it through
 * its own `invoke` on channel `mcp`, which means through the gate — so a write
 * asks the person in the application's tab, exactly as an AI tool call does.
 *
 * The control secret never appears here. The launcher authenticated the client;
 * what crosses to the child is the call and the client's name, and the child has
 * no way to authenticate anything and no need to.
 */
export interface Invoke extends Base {
  readonly type: 'invoke';
  readonly route?: string;
  readonly input?: unknown;
  /** The MCP client's own name, for the record and for the question. */
  readonly client?: string;
  /**
   * Set by the launcher when the call is one of the release's own acceptance
   * examples, run by the launcher itself rather than forwarded for an MCP
   * client. The child runs it on channel `user` — the check stands in for the
   * person, as it did when it arrived over the launch URL — and nothing but
   * the launcher's own code sets it. Running checks over IPC rather than HTTP
   * is what keeps the child's one-time launch token unspent for the tab the
   * person is about to open.
   */
  readonly as?: 'check';
  readonly requestId?: string;
  readonly ok?: boolean;
  readonly output?: unknown;
  readonly code?: string;
  readonly message?: string;
}

/** Child → launcher: something unrecoverable; the child exits after sending. */
export interface Fatal extends Base {
  readonly type: 'fatal';
  /** One sentence, no stack, no secret. */
  readonly reason: string;
}

/** Anything that may legitimately cross the channel. */
export type Message = Hello | Ready | Health | Drain | Shutdown | Fatal | Migrate | Invoke;

/**
 * The most a single message may weigh.
 *
 * A lifecycle message is a handful of short fields. A bound is here so that a
 * child which starts sending something else — a stack, a log, a document —
 * fails loudly at the channel instead of filling the launcher's heap.
 */
export const MAX_MESSAGE_BYTES = 16_384;
