/**
 * A cancellable stream.
 *
 * The Cancel button here does the real thing: it sends a `CANCEL` frame, the
 * host's `sink.signal` aborts, and the loop in `src/host/operations.ts` stops
 * at its next checkpoint. It is not a UI-only "stop showing me this" — you can
 * watch the process's CPU use drop.
 *
 * This is worth being deliberate about, because the obvious implementation is
 * wrong: abandoning the async iterator on the browser side sends nothing, and
 * the host would count every prime whether anyone was listening or not.
 */
import { useId, useState } from 'react';
import { useStream } from 'broapp/react';

import type { AppContract } from '../shared/contract.ts';

/*
 * Sized so that cancelling is something you can actually do. Trial division
 * over 60 million takes tens of seconds on a current laptop, which leaves room
 * to press Cancel and watch it stop; a workload that finishes in a second
 * would make the button look like it worked whether it did or not.
 */
const BOUNDS = [
  { label: 'Small (2 million)', value: 2_000_000 },
  { label: 'Medium (20 million)', value: 20_000_000 },
  { label: 'Large (60 million)', value: 60_000_000 },
] as const;

export function PrimesCard(): React.ReactElement {
  const [upTo, setUpTo] = useState<number>(20_000_000);
  const primes = useStream<AppContract, 'demo.countPrimes'>('demo.countPrimes');
  const selectId = useId();
  const headingId = useId();

  const percent = Math.round((primes.last?.progress ?? 0) * 100);
  const finished = primes.last?.done === true;

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 className="card__title" id={headingId}>
        Count prime numbers
      </h2>
      <p className="card__lede">
        A slow calculation running on this computer, reporting as it goes. Stop it at any point.
      </p>

      <div className="form__row">
        <label className="form__label form__label--inline" htmlFor={selectId}>
          Count up to
        </label>
        <select
          id={selectId}
          className="input input--select"
          value={upTo}
          disabled={primes.running}
          onChange={(event) => setUpTo(Number(event.target.value))}
        >
          {BOUNDS.map((bound) => (
            <option key={bound.value} value={bound.value}>
              {bound.label}
            </option>
          ))}
        </select>

        {primes.running ? (
          <button className="button button--danger" type="button" onClick={primes.cancel}>
            Cancel
          </button>
        ) : (
          <button
            className="button button--primary"
            type="button"
            onClick={() => void primes.start({ upTo })}
          >
            Start
          </button>
        )}
      </div>

      {/*
        A native <progress> element announces its value to assistive
        technology without any ARIA of its own, and respects the platform's
        own reduced-motion behaviour.
      */}
      <progress
        className="progress"
        max={100}
        value={percent}
        aria-labelledby={headingId}
      >
        {percent}%
      </progress>

      <p className="message" role="status" aria-live="polite">
        {primes.error !== null
          ? primes.error.message
          : primes.running
            ? `Examined ${(primes.last?.examined ?? 0).toLocaleString()} numbers — ${(primes.last?.found ?? 0).toLocaleString()} primes so far (${String(percent)}%).`
            : finished
              ? `Finished: ${(primes.last?.found ?? 0).toLocaleString()} primes below ${upTo.toLocaleString()}.`
              : primes.cancelled
                ? `Stopped after ${(primes.last?.examined ?? 0).toLocaleString()} numbers.`
                : 'Not running.'}
      </p>
    </section>
  );
}
