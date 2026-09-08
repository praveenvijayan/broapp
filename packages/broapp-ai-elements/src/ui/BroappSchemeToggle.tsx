/**
 * Light, system or dark, as three segmented buttons.
 *
 * Pure on purpose: it says what was chosen and reports a choice, and applying
 * one — writing `color-scheme` onto the document, remembering it — is the
 * caller's, because only the caller knows where its own preference lives.
 */
import * as React from 'react';

import { Monitor, Moon, Sun } from 'lucide-react';

/** What a scheme choice can be. `"system"` follows the operating system. */
export type BroappScheme = 'light' | 'system' | 'dark';

/** Which way the three buttons run. */
export type BroappSchemeOrientation = 'horizontal' | 'vertical';

/** Props for {@link BroappSchemeToggle}. */
export interface BroappSchemeToggleProps {
  readonly value: BroappScheme;
  onChange(value: BroappScheme): void;
  /** The group's accessible name. Default "Colour scheme". */
  readonly label?: string;
  /**
   * `"vertical"` stacks the three buttons, which is what fits a narrow rail:
   * three `1.5rem` buttons on one line, plus padding and border, need about
   * `5rem`, and a rail is `3rem`. Default `"horizontal"`.
   */
  readonly orientation?: BroappSchemeOrientation;
}

const OPTIONS: readonly {
  readonly value: BroappScheme;
  readonly label: string;
  readonly Icon: typeof Sun;
}[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function BroappSchemeToggle({
  value,
  onChange,
  label = 'Colour scheme',
  orientation = 'horizontal',
}: BroappSchemeToggleProps): React.ReactElement {
  return (
    <div
      aria-label={label}
      className="broapp-chat-scheme"
      // The default is the absence of the attribute rather than
      // `data-orientation="horizontal"`: one direction is the stylesheet's
      // own, and a selector for it would be a rule that changes nothing.
      {...(orientation === 'vertical' ? { 'data-orientation': 'vertical' } : {})}
      role="radiogroup"
    >
      {OPTIONS.map((option) => (
        <button
          aria-checked={option.value === value}
          aria-label={option.label}
          className="broapp-chat-scheme__button"
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          title={option.label}
          type="button"
        >
          <option.Icon aria-hidden="true" size={15} />
        </button>
      ))}
    </div>
  );
}
