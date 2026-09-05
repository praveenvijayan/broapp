/**
 * A typed call to the host.
 *
 * `useOperation("demo.greet")` is typed from the contract: the argument shape,
 * the result shape, and the operation name are all checked. Renaming the
 * operation in `src/shared/contract.ts` breaks this file at compile time,
 * which is the point.
 */
import { useId, useState, type FormEvent } from 'react';
import { useOperation } from 'broapp/react';

import type { AppContract } from '../shared/contract.ts';

export function GreetCard(): React.ReactElement {
  const [name, setName] = useState('');
  const greet = useOperation<AppContract, 'demo.greet'>('demo.greet');
  const inputId = useId();
  const errorId = useId();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void greet.run({ name });
  }

  return (
    <section className="card" aria-labelledby={`${inputId}-heading`}>
      <h2 className="card__title" id={`${inputId}-heading`}>
        Say hello
      </h2>
      <p className="card__lede">
        Sends what you type to the application and shows what it sends back.
      </p>

      <form className="form" onSubmit={onSubmit}>
        <label className="form__label" htmlFor={inputId}>
          Your name
        </label>
        <div className="form__row">
          <input
            id={inputId}
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={64}
            autoComplete="off"
            /*
              The host validates this independently. `aria-invalid` and
              `aria-describedby` are what make the failure reach a screen
              reader, not just a sighted user.
            */
            aria-invalid={greet.error !== null}
            aria-describedby={greet.error === null ? undefined : errorId}
          />
          <button className="button button--primary" type="submit" disabled={greet.pending}>
            {greet.pending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      {greet.error !== null && (
        <p className="message message--error" id={errorId} role="alert">
          {greet.error.message}
        </p>
      )}

      {greet.data !== null && greet.error === null && (
        <p className="message message--ok">
          {greet.data.greeting}{' '}
          <span className="message__meta">
            Answered at {new Date(greet.data.at).toLocaleTimeString()}.
          </span>
        </p>
      )}
    </section>
  );
}
