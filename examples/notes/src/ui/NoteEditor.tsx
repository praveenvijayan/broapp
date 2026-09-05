/**
 * A note form, used both for creating and for editing.
 *
 * `maxLength` matches the contract's bound, so the field stops the user before
 * the host has to. The host still enforces it — this is the courtesy, not the
 * rule.
 */
import { useId, useState, type FormEvent } from 'react';

import { LIMITS } from '../shared/contract.ts';

export interface NoteEditorProps {
  readonly submitLabel: string;
  readonly initial?: { title: string; body: string };
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (input: { title: string; body: string }) => void | Promise<void>;
  readonly onCancel?: () => void;
}

export function NoteEditor({
  submitLabel,
  initial,
  pending,
  error,
  onSubmit,
  onCancel,
}: NoteEditorProps): React.ReactElement {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onSubmit({ title, body });
    if (initial === undefined) {
      setTitle('');
      setBody('');
    }
  }

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <label className="form__label" htmlFor={titleId}>
        Title
      </label>
      <input
        id={titleId}
        className="input input--block"
        value={title}
        maxLength={LIMITS.title}
        onChange={(event) => setTitle(event.target.value)}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : errorId}
        autoComplete="off"
        required
      />

      <label className="form__label" htmlFor={bodyId}>
        Details <span className="form__hint">(optional)</span>
      </label>
      <textarea
        id={bodyId}
        className="input input--block textarea"
        value={body}
        maxLength={LIMITS.body}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
      />

      {error !== null && (
        <p className="message message--error" id={errorId} role="alert">
          {error}
        </p>
      )}

      <div className="form__row form__row--end">
        {onCancel !== undefined && (
          <button className="button" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="button button--primary" type="submit" disabled={pending || title.trim() === ''}>
          {pending ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
