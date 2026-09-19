/**
 * The top of every panel that opens over the page: Log, Knowledge, Backlog and
 * Settings. One component, so the four have the same title, the same rule under
 * it and the same way out in the same corner.
 */
import type * as React from 'react';
import { X } from 'lucide-react';

export interface PanelHeaderProps {
  readonly title: string;
  onClose(): void;
  /** Actions that belong to the whole panel, drawn before the close button. */
  readonly children?: React.ReactNode;
}

export function PanelHeader({ title, onClose, children }: PanelHeaderProps): React.ReactElement {
  return (
    <div className="launcher__settings-header">
      <h2 className="launcher__panel-title">{title}</h2>
      <div className="launcher__row-actions">
        {children}
        <button aria-label="Close" className="launcher__icon-button" onClick={onClose} title="Close" type="button">
          <X aria-hidden="true" size={18} />
        </button>
      </div>
    </div>
  );
}
