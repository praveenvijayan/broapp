/**
 * *Work without asking*: the person's standing approval, where they can see
 * it and take it back.
 *
 * Three places draw it — a section in Settings, one line in the engineer's
 * top bar while it is on, and the Overview's muted line — and every word comes
 * from `standing-words.ts`. The switch is the one the components document
 * decides: `role="switch"` at the right of its label, the consequence as a
 * hint. Its state is the knob's position and the switch's checked state, not
 * a colour alone.
 */
import * as React from 'react';
import { useCallback, useEffect } from 'react';

import { useOperation } from 'broapp/react';

import { standingCovers } from '../../engineer/standing.ts';
import type { LauncherContract } from '../contract.ts';
import { STANDING_WORDS } from '../standing-words.ts';

/**
 * What the launcher offers on one approval card: the third button, for a
 * question the switch would have answered, and only while it is off — once it
 * is on, such a question never reaches a card. `null` offers nothing.
 */
export function standingOfferFor(
  on: boolean,
  call: { readonly tool: string; readonly input: unknown },
  turnOn: () => Promise<void>,
): { label: string; grant(): Promise<void> } | null {
  if (on || !standingCovers(call.tool, call.input)) return null;
  return { label: STANDING_WORDS.cardLabel, grant: turnOn };
}

/** Props for {@link StandingSwitch}. */
export interface StandingSwitchProps {
  /** `null` until the first read answers. */
  readonly standing: boolean | null;
  /** While a write is on its way the switch is disabled, not moved ahead of the disk. */
  readonly pending: boolean;
  /** A refusal, as a sentence. */
  readonly error: string | null;
  onChange(standing: boolean): void;
}

/** The section and its switch, drawn from what it is given. */
export function StandingSwitch({ standing, pending, error, onChange }: StandingSwitchProps): React.ReactElement {
  return (
    <section aria-labelledby="launcher-standing-title" className="launcher__section">
      <header className="launcher__section-header">
        <h2 className="launcher__section-title" id="launcher-standing-title">
          {STANDING_WORDS.sectionTitle}
        </h2>
      </header>
      <label className="launcher__switch-row" htmlFor="launcher-standing">
        <span className="launcher__switch-label">{STANDING_WORDS.switchLabel}</span>
        <input
          aria-describedby="launcher-standing-hint"
          checked={standing === true}
          className="launcher__switch"
          disabled={pending || standing === null}
          id="launcher-standing"
          onChange={(event) => onChange(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
      </label>
      <p className="launcher__section-hint" id="launcher-standing-hint">
        {STANDING_WORDS.hint}
      </p>
      {error === null ? null : (
        <p className="launcher__message launcher__message--error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The Settings section, wired: read when the drawer opens, written on a flip,
 * and whoever else shows the switch's state told once it changed.
 *
 * `known` is what the Overview's last read said; when the card or the top bar
 * changes the switch while the drawer is open, that changes, and the drawer
 * reads again rather than showing what it read when it opened.
 */
export function StandingSection({ known, onChanged }: { known: boolean | undefined; onChanged(): void }): React.ReactElement {
  const read = useOperation<LauncherContract, 'launcher.standingGet'>('launcher.standingGet');
  const write = useOperation<LauncherContract, 'launcher.standingSet'>('launcher.standingSet');
  const { run: readNow } = read;
  const { run: writeNow } = write;
  useEffect(() => {
    void readNow(undefined);
  }, [readNow, known]);
  const change = useCallback(
    (standing: boolean): void => {
      void writeNow({ standing }).then(() => {
        void readNow(undefined);
        onChanged();
      });
    },
    [writeNow, readNow, onChanged],
  );
  // What the disk said, and nothing ahead of it: until the first read
  // answers, nothing is claimed either way, and a flip shows once it is read
  // back.
  const standing = read.data?.standing ?? null;
  return (
    <StandingSwitch
      error={write.error?.message ?? read.error?.message ?? null}
      onChange={change}
      pending={write.pending || (write.data !== null && read.pending)}
      standing={standing}
    />
  );
}

/** Props for {@link StandingLine}. */
export interface StandingLineProps {
  readonly pending: boolean;
  onAskAgain(): void;
}

/** The engineer's top bar while it is on: what is true, and the way back. */
export function StandingLine({ pending, onAskAgain }: StandingLineProps): React.ReactElement {
  return (
    <span className="launcher__standing" role="status">
      {STANDING_WORDS.topBarLine}
      <button className="launcher__standing-link" disabled={pending} onClick={onAskAgain} type="button">
        {STANDING_WORDS.askAgain}
      </button>
    </span>
  );
}
