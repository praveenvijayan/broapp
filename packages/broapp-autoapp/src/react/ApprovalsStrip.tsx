/**
 * What an agent is waiting for permission to do.
 *
 * Polled rather than streamed, on purpose: a stream would be one more thing to
 * keep alive across a reconnect, and two seconds is not a meaningful wait for a
 * person who is deciding something. The polling stops when there is nothing
 * pending and starts again on any answer, so an idle tab is not asking.
 *
 * The input is shown as formatted JSON and nothing else. A person approving a
 * write needs to see the actual arguments, and any prettier rendering would be
 * a place for a value to look like something it is not.
 */
import * as React from 'react';

import { useOperation } from 'broapp/react';

import type { AutoappContract } from '../shared/contract.ts';

/** How often to ask while anything is pending. */
const POLL_MS = 2_000;

/** One question, as the host describes it. */
type Question = {
  requestId: string;
  channel: string;
  caller: string;
  releaseId: string;
  route: string;
  effect: string;
  input?: unknown;
  argumentsHash: string;
};

/**
 * Who is asking, in words rather than in an identifier.
 *
 * The channel matters more than the caller here: "an agent in another program"
 * is a different thing to be asked by than "this application's own assistant",
 * and a person deciding needs to know which.
 */
function who(question: Question): string {
  const name = question.caller.replace(/^(ai|mcp|workflow):/, '');
  switch (question.channel) {
    case 'mcp':
      return `${name} — an agent in another program, over MCP`;
    case 'workflow':
      return `a saved workflow`;
    case 'ai':
      return `this application’s assistant`;
    default:
      return question.caller;
  }
}

export function ApprovalsStrip(): React.ReactElement | null {
  const list = useOperation<AutoappContract, 'autoapp.approvalsList'>('autoapp.approvalsList');
  const answer = useOperation<AutoappContract, 'autoapp.approvalsAnswer'>('autoapp.approvalsAnswer');
  const { run: refresh } = list;

  React.useEffect(() => {
    void refresh(undefined);
    const timer = setInterval(() => void refresh(undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const pending = (list.data?.pending ?? []) as readonly Question[];
  if (pending.length === 0) return null;

  async function decide(question: Question, approved: boolean): Promise<void> {
    // The release and the arguments hash travel with the answer, so the host
    // can check that this is an answer to the question it asked. An answer that
    // names a different release — because the application was updated while the
    // person was deciding — is a mismatch, not an approval.
    await answer.run({
      requestId: question.requestId,
      approved,
      releaseId: question.releaseId,
      argumentsHash: question.argumentsHash,
    });
    await refresh(undefined);
  }

  return (
    <section className="autoapp-approvals" data-autoapp-approvals={String(pending.length)}>
      <h2 className="autoapp-approvals__title">
        {pending.length === 1 ? 'Something is waiting for you' : `${String(pending.length)} things are waiting for you`}
      </h2>
      {pending.map((question) => (
        <div className="autoapp-approvals__item" key={question.requestId}>
          <p className="autoapp-approvals__what">
            <strong>{who(question)}</strong> wants to run <code>{question.route}</code> (
            {question.effect}).
          </p>
          <pre className="autoapp-approvals__input">{JSON.stringify(question.input, null, 2)}</pre>
          <div className="autoapp-approvals__actions">
            <button
              type="button"
              className="autoapp-button"
              disabled={answer.pending}
              onClick={() => void decide(question, true)}
            >
              Approve
            </button>
            <button
              type="button"
              className="autoapp-button"
              disabled={answer.pending}
              onClick={() => void decide(question, false)}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
      {answer.data?.result === 'mismatch' && (
        <p className="autoapp-message autoapp-message--error" role="alert">
          That answer was about a different version of the question, so it was refused. The
          application may have been updated while you were deciding.
        </p>
      )}
    </section>
  );
}
