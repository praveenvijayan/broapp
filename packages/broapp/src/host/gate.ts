/**
 * The execution gate.
 *
 * One place decides whether a call runs. Every path into an application's
 * operations — a click in the browser, a model's tool call, an external agent
 * over MCP, a workflow step — arrives here with an envelope saying who is
 * asking, and leaves with a record saying what happened. There is no second
 * door: an adapter that does not call `guard` is a bug, not a shortcut.
 *
 * The policy is deliberately three rows and no configuration language. What
 * makes it trustworthy is not its expressiveness but where the inputs come
 * from: the `channel` is set by the trusted adapter that received the request
 * and never read out of model output, tool arguments or anything a browser
 * sent. A model cannot claim to be the user, because nothing it can write is
 * consulted when the channel is chosen.
 */
import { createHash } from 'node:crypto';

import type { Effect } from '../shared/contract.ts';
import { INTERNAL_ERROR_MESSAGE, PublicError, publicError } from '../shared/errors.ts';

import type { HostLogger } from './app.ts';

/** Who is asking. Set by an adapter, never by the thing being adapted. */
export type Channel = 'user' | 'ai' | 'mcp' | 'workflow';
/** `preview` runs against a copy of the data, so nothing may leave the machine. */
export type ExecutionMode = 'live' | 'preview';
/** How the gate answered. */
export type Decision = 'allowed' | 'confirmed' | 'denied' | 'refused';
/** How the call itself ended, once it was allowed to start. */
export type Outcome = 'succeeded' | 'failed' | 'cancelled';
/** What the policy says about one (channel, effect, mode). */
export type PolicyVerdict = 'allow' | 'confirm' | 'refuse';

/**
 * Who is asking, on behalf of what, and how the answer may be obtained.
 *
 * Built by the trusted adapter that received the request — the bridge
 * handler, the AI runner, the MCP adapter, the workflow runner — and never
 * from anything a model, a browser or an MCP client sent. That is the whole
 * basis of the policy: a model cannot claim to be the user.
 */
export interface Envelope {
  /** Unique per request. Correlates the question, the answer and the record. */
  readonly requestId: string;
  readonly channel: Channel;
  /** Free text for records: 'tab', 'ai:<runId>', 'mcp:<client>', 'workflow:<id>'. */
  readonly caller: string;
  /** May only tighten the gate's default: `preview` wins over `live`. */
  readonly mode?: ExecutionMode;
  readonly signal?: AbortSignal;
  /** Who to ask when the policy says `confirm`. Absent means nobody, so denied. */
  readonly approver?: Approver;
  /**
   * The effect an adapter resolved for a route the contract leaves silent.
   *
   * It fills a gap and never widens one: a route that declares an effect keeps
   * it, whatever an adapter says. The AI layer's allow list is the reason this
   * exists — an operation named under `read` there is a read tool even though
   * an undeclared route is `write` everywhere else, and the gate has to be told
   * the same thing the model was.
   */
  readonly effectHint?: Effect;
}

/** One decision to make: an envelope plus the route it is about. */
export interface GuardRequest extends Envelope {
  readonly route: string;
  readonly effect: Effect;
  /** Already validated by the contract. Shown to the approver and hashed. */
  readonly input: unknown;
}

/** What a person is asked, and what their answer has to name to count. */
export interface ApprovalQuestion {
  readonly requestId: string;
  readonly channel: Channel;
  readonly caller: string;
  readonly appId: string;
  readonly releaseId: string;
  readonly route: string;
  readonly effect: Effect;
  readonly input: unknown;
  readonly argumentsHash: string;
}

/** Somewhere a question can be put to a person. */
export interface Approver {
  /**
   * Ask a person. Resolves `true` only for an approval that names this
   * question. Must resolve `false` when `signal` aborts.
   */
  ask(question: ApprovalQuestion, signal: AbortSignal): Promise<boolean>;
}

/** What the gate writes down about one decision, whatever it was. */
export interface ExecutionRecord extends ApprovalQuestion {
  readonly mode: ExecutionMode;
  readonly decision: Decision;
  readonly outcome?: Outcome;
  /** A sentence safe to show. Never a stack, never a secret. */
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** Where records go. A run store, a log, or nothing. */
export interface Recorder {
  record(record: ExecutionRecord): void;
}

/** Options for {@link createGate}. */
export interface GateOptions {
  readonly appId: string;
  readonly releaseId: string;
  readonly recorder?: Recorder;
  /** Default 120_000. */
  readonly confirmTimeoutMs?: number;
  /** Default 'live'. A preview child passes 'preview'. */
  readonly mode?: ExecutionMode;
  readonly logger?: HostLogger;
}

/** The one door. */
export interface Gate {
  readonly appId: string;
  readonly releaseId: string;
  readonly mode: ExecutionMode;
  /**
   * Decide, ask if needed, record, run.
   *
   * Throws `PublicError` with code `rejected` when the policy refuses or a
   * person declines, times out or the request is cancelled while waiting.
   * `run` is called at most once and only after an allow or a confirmed
   * approval.
   */
  guard<T>(request: GuardRequest, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** How long a question waits when the gate is not told otherwise. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * The whole v1 policy. Pure, exported so the table can be tested row by row.
 *
 * Read for anybody, always: nothing changes, so there is nothing to approve.
 * The owner's own click is allowed to write, because the owner is who the
 * application belongs to. Every other channel is an agent acting on their
 * behalf and asks first. `preview` refuses `external` outright for everyone:
 * a preview runs against a copy of the data, and a copy of the data is not a
 * copy of the world — a message sent from a preview is sent for real.
 */
export function decide(channel: Channel, effect: Effect, mode: ExecutionMode): PolicyVerdict {
  if (mode === 'preview' && effect === 'external') return 'refuse';
  if (effect === 'read') return 'allow';
  if (channel === 'user') return 'allow';
  return 'confirm';
}

/**
 * Canonical JSON (object keys sorted at every depth) hashed with sha256, hex,
 * first 32 characters.
 *
 * Sorting is what makes the hash an identity rather than a formatting
 * accident: the question a person was shown and the answer they gave have to
 * be about the same arguments, and two encoders of the same object must not
 * disagree about that.
 */
export function argumentsHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 32);
}

/**
 * JSON with every object's keys in sorted order, at every depth.
 *
 * Exported because more than one thing needs the same answer to "are these two
 * values the same value": the gate, for an approval, and Autoapp's release
 * identity, for a contract. Two sorters would eventually disagree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/** A signal that never aborts, for a request that brought none. */
function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

/** Build the gate one application runs behind. */
export function createGate(options: GateOptions): Gate {
  const logger: HostLogger = options.logger ?? console;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const gateMode: ExecutionMode = options.mode ?? 'live';
  const recorder = options.recorder;

  /**
   * Write one record.
   *
   * A recorder that throws is a broken diagnostic, not a reason to fail the
   * user's call, so the throw stops here and is logged instead.
   */
  function write(record: ExecutionRecord): void {
    if (recorder === undefined) return;
    try {
      recorder.record(record);
    } catch (cause) {
      logger.error(
        `[broapp] the execution recorder failed for ${record.route}: ${String(cause instanceof Error ? (cause.stack ?? cause.message) : cause)}`,
      );
    }
  }

  const gate: Gate = {
    appId: options.appId,
    releaseId: options.releaseId,
    mode: gateMode,

    async guard<T>(request: GuardRequest, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      // Either side may tighten to `preview`; neither may loosen back. A live
      // gate asked to preview obeys, and a preview gate handed `live` in an
      // envelope stays a preview.
      const mode: ExecutionMode =
        gateMode === 'preview' || request.mode === 'preview' ? 'preview' : 'live';
      const question: ApprovalQuestion = {
        requestId: request.requestId,
        channel: request.channel,
        caller: request.caller,
        appId: gate.appId,
        releaseId: gate.releaseId,
        route: request.route,
        effect: request.effect,
        input: request.input,
        argumentsHash: argumentsHash(request.input),
      };
      const at = Date.now();

      const verdict = decide(request.channel, request.effect, mode);
      if (verdict === 'refuse') {
        write({ ...question, mode, decision: 'refused', startedAt: at, endedAt: Date.now() });
        throw publicError.rejected(`${request.route} is not allowed in preview`);
      }

      let decision: Decision = 'allowed';
      if (verdict === 'confirm') {
        const approver = request.approver;
        if (approver === undefined) {
          write({ ...question, mode, decision: 'denied', startedAt: at, endedAt: Date.now() });
          throw publicError.rejected(`${request.route} needs approval and nobody can give it`);
        }
        // The question's own deadline is separate from the request's: a person
        // who never answers must not hold a tool call open forever, and a
        // cancelled request must stop asking.
        const asking = new AbortController();
        const timer = setTimeout(() => asking.abort(new Error('the question timed out')), confirmTimeoutMs);
        const relay = (): void => asking.abort(new Error('the request was cancelled'));
        request.signal?.addEventListener('abort', relay, { once: true });
        if (request.signal?.aborted === true) relay();
        let approved: boolean;
        try {
          approved = await approver.ask(question, asking.signal);
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', relay);
        }
        if (!approved) {
          const cancelled = request.signal?.aborted === true;
          write({
            ...question,
            mode,
            decision: 'denied',
            ...(cancelled ? { outcome: 'cancelled' as const } : {}),
            startedAt: at,
            endedAt: Date.now(),
          });
          throw publicError.rejected(`${request.route} was not approved`);
        }
        decision = 'confirmed';
      }

      const signal = request.signal ?? neverAborts();
      const startedAt = Date.now();
      try {
        const value = await run(signal);
        write({ ...question, mode, decision, outcome: 'succeeded', startedAt, endedAt: Date.now() });
        return value;
      } catch (cause) {
        // A `PublicError` was written for whoever is watching and keeps its
        // words. Anything else may name a path, a query or a token, so the
        // record gets the same fixed sentence the browser would have seen.
        write({
          ...question,
          mode,
          decision,
          outcome: signal.aborted ? 'cancelled' : 'failed',
          error: cause instanceof PublicError ? cause.message : INTERNAL_ERROR_MESSAGE,
          startedAt,
          endedAt: Date.now(),
        });
        throw cause;
      }
    },
  };

  return gate;
}
