/**
 * A form over one action.
 *
 * Client-side validation here is a courtesy, not a control: `required`, `min`
 * and `max` are checked so a person is told before a round trip, and the host
 * checks the same things again through the contract because a browser is not
 * something to trust. When the host disagrees, its message is what is shown —
 * it is the one that knows the real rule.
 */
import * as React from 'react';

import { resolveValue } from '../bind.ts';
import { usePage } from '../context.tsx';
import type { Component, Field } from '../../views/types.ts';

/** What a field starts as when the specification does not say. */
function blank(field: Field): unknown {
  switch (field.type) {
    case 'boolean':
      return false;
    case 'number':
      return '';
    default:
      return '';
  }
}

/** Check one value against what the field says about itself. */
function problemWith(field: Field, value: unknown): string | null {
  if (field.type === 'boolean') return null;
  const text = value === null || value === undefined ? '' : String(value);
  if (field.required === true && text.trim() === '') return `${field.label} is required.`;
  if (text === '') return null;
  if (field.type === 'number') {
    const asNumber = Number(text);
    if (!Number.isFinite(asNumber)) return `${field.label} must be a number.`;
    if (field.min !== undefined && asNumber < field.min) {
      return `${field.label} must be at least ${String(field.min)}.`;
    }
    if (field.max !== undefined && asNumber > field.max) {
      return `${field.label} must be at most ${String(field.max)}.`;
    }
    return null;
  }
  if (field.min !== undefined && text.length < field.min) {
    return `${field.label} must be at least ${String(field.min)} characters.`;
  }
  if (field.max !== undefined && text.length > field.max) {
    return `${field.label} must be at most ${String(field.max)} characters.`;
  }
  return null;
}

export function Form({ component }: { readonly component: Component }): React.ReactElement {
  const page = usePage();
  const fields = component.fields ?? [];
  const submit = component.submit;

  /** The initial values, recomputed whenever what they are drawn from changes. */
  const initial = React.useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.initial === undefined) {
        out[field.id] = blank(field);
        continue;
      }
      try {
        const resolved = resolveValue(field.initial, {
          params: page.params,
          sources: Object.fromEntries(
            Object.entries(page.sources).map(([id, state]) => [id, state.data]),
          ),
        });
        out[field.id] = resolved ?? blank(field);
      } catch {
        // An initial value drawn from a source that has not arrived is not an
        // error; the field simply starts empty and fills in on the next render.
        out[field.id] = blank(field);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, page.params, page.sources]);

  const [values, setValues] = React.useState<Record<string, unknown>>(initial);
  const [touched, setTouched] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // A form whose initial values arrive after the first render — because its
  // source was still loading — has to adopt them, but only while the person
  // has not started typing, or their work would be thrown away underneath them.
  React.useEffect(() => {
    if (!touched) setValues(initial);
  }, [initial, touched]);

  function set(id: string, value: unknown): void {
    setTouched(true);
    setValues((current) => ({ ...current, [id]: value }));
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submit === undefined) return;
    for (const field of fields) {
      const problem = problemWith(field, values[field.id]);
      if (problem !== null) {
        setFailure(problem);
        return;
      }
    }
    setFailure(null);
    setBusy(true);
    // Numbers reach the host as numbers: the contract's schema refuses a
    // string, and an input element only ever produces one.
    const coerced: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.id];
      coerced[field.id] = field.type === 'number' ? Number(value) : value;
    }
    const outcome = await page.run(submit, { params: page.params, fields: coerced });
    setBusy(false);
    setFailure(outcome);
    if (outcome === null) {
      setTouched(false);
      setValues(initial);
    }
  }

  return (
    <form className="autoapp-form" data-autoapp-id={component.id} onSubmit={(event) => void onSubmit(event)}>
      {component.label !== undefined && component.label !== '' && (
        <h2 className="autoapp-form__title">{component.label}</h2>
      )}
      {fields.map((field) => {
        const id = `${component.id}-${field.id}`;
        const value = values[field.id];
        return (
          <div className="autoapp-field" key={field.id} data-autoapp-id={field.id}>
            <label className="autoapp-field__label" htmlFor={id}>
              {field.label}
            </label>
            {field.type === 'textarea' ? (
              <textarea
                id={id}
                className="autoapp-field__input"
                rows={5}
                value={String(value ?? '')}
                onChange={(event) => set(field.id, event.target.value)}
              />
            ) : field.type === 'boolean' ? (
              <input
                id={id}
                className="autoapp-field__check"
                type="checkbox"
                checked={value === true}
                onChange={(event) => set(field.id, event.target.checked)}
              />
            ) : (
              <input
                id={id}
                className="autoapp-field__input"
                type={field.type === 'number' ? 'number' : 'text'}
                value={String(value ?? '')}
                onChange={(event) => set(field.id, event.target.value)}
              />
            )}
          </div>
        );
      })}
      {failure !== null && (
        <p className="autoapp-message autoapp-message--error" role="alert">
          {failure}
        </p>
      )}
      <button type="submit" className="autoapp-button" disabled={busy}>
        {submit?.label ?? 'Save'}
      </button>
    </form>
  );
}
