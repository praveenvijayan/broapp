/**
 * The table a waiting question and a later answer meet in.
 *
 * An approver has to ask somebody, and the somebody is at the other end of a
 * route: a chat stream, a launcher tab, an MCP client's own UI. So the ask and
 * the answer are two separate calls, and something has to hold the question in
 * between. That is all this is — with one property that matters more than the
 * bookkeeping.
 *
 * An answer must name the question it is answering. A `requestId` alone would
 * let an answer meant for one call approve a different one that happened to be
 * pending under the same identifier after a rebuild, or after a model changed
 * its arguments between the question and the click. So an answer may carry the
 * release and the arguments hash it believes it is approving, and a value that
 * does not match the pending question is a denial, not a near miss.
 */
import type { HostLogger } from './app.ts';
import type { ApprovalQuestion, Approver } from './gate.ts';

/** What the route that received a person's answer passes back in. */
export interface ApprovalAnswer {
  readonly requestId: string;
  readonly approved: boolean;
  /** When given, must equal the pending question's value or the answer is a mismatch. */
  readonly releaseId?: string;
  readonly argumentsHash?: string;
}

/** What happened to an answer. */
export type AnswerResult = 'accepted' | 'unknown' | 'mismatch';

/** An {@link Approver} whose answers arrive later, over some other route. */
export interface PendingApprovals extends Approver {
  /** Called by the route that receives the person's answer. */
  answer(answer: ApprovalAnswer): AnswerResult;
  /**
   * Questions currently waiting, for a UI to show. `input` is shown as-is;
   * adapters must not put secrets in inputs.
   */
  readonly pending: readonly ApprovalQuestion[];
}

/** One question, and the callback that settles it. */
interface Waiting {
  readonly question: ApprovalQuestion;
  settle(approved: boolean): void;
}

/** Build a pending-approval table. */
export function createPendingApprovals(logger?: HostLogger): PendingApprovals {
  const log: HostLogger = logger ?? console;
  const waiting = new Map<string, Waiting>();

  return {
    ask(question: ApprovalQuestion, signal: AbortSignal): Promise<boolean> {
      // Two questions under one identifier would make an answer ambiguous, and
      // an ambiguous approval is the one thing this table exists to prevent.
      // The caller chose the identifier, so a collision is its bug.
      if (waiting.has(question.requestId)) {
        throw new TypeError(
          `an approval for request ${JSON.stringify(question.requestId)} is already pending`,
        );
      }
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (approved: boolean): void => {
          if (settled) return;
          settled = true;
          waiting.delete(question.requestId);
          signal.removeEventListener('abort', onAbort);
          resolve(approved);
        };
        // A question nobody answers is a denial, not a hung call: the person
        // may have closed the tab, and nothing may run unattended.
        const onAbort = (): void => finish(false);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) finish(false);
        else waiting.set(question.requestId, { question, settle: finish });
      });
    },

    answer(answer: ApprovalAnswer): AnswerResult {
      const entry = waiting.get(answer.requestId);
      // Nobody waiting covers both a stale answer and a second answer for a
      // question that has already been settled and removed.
      if (entry === undefined) return 'unknown';

      const wrong =
        answer.releaseId !== undefined && answer.releaseId !== entry.question.releaseId
          ? 'releaseId'
          : answer.argumentsHash !== undefined &&
              answer.argumentsHash !== entry.question.argumentsHash
            ? 'argumentsHash'
            : null;
      if (wrong !== null) {
        // An answer about a different release or different arguments is not
        // this question's answer. It is treated as a denial rather than
        // ignored, so the caller stops waiting instead of hanging until the
        // deadline for a question that will never be answered correctly.
        log.warn(
          `[broapp] an approval for ${entry.question.route} named a different ${wrong} and was refused`,
        );
        entry.settle(false);
        return 'mismatch';
      }

      entry.settle(answer.approved);
      return 'accepted';
    },

    get pending(): readonly ApprovalQuestion[] {
      return [...waiting.values()].map((entry) => entry.question);
    },
  };
}
