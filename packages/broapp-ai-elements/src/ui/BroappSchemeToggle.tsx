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

/** Props for {@link BroappSchemeToggle}. */
export interface BroappSchemeToggleProps {
  readonly value: BroappScheme;
  onChange(value: BroappScheme): void;
  /** The group's accessible name. Default "Colour scheme". */
  readonly label?: string;
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
}: BroappSchemeToggleProps): React.ReactElement {
  return (
    <div aria-label={label} className="broapp-chat-scheme" role="radiogroup">
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
