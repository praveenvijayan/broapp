/**
 * The conversation's own `…` menu.
 *
 * Deleting asks twice, and it asks inside the menu: a browser `confirm()`
 * blocks the whole tab, looks like nothing else in the application, and in a
 * page that is already a window of its own reads like a fault rather than a
 * question.
 */
import * as React from 'react';

import { Copy, Eraser, MoreHorizontal, Trash2 } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx';

/** Props for {@link BroappChatMenu}. */
export interface BroappChatMenuProps {
  /** Put the transcript on the clipboard. */
  onCopy(): void;
  /** Empty the conversation, keeping it in the list. */
  onClear(): void;
  /** Delete the conversation itself. Asked twice before it is called. */
  onDelete(): void;
  readonly disabled?: boolean;
}

export function BroappChatMenu({
  onCopy,
  onClear,
  onDelete,
  disabled,
}: BroappChatMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  return (
    <DropdownMenu
      onOpenChange={(next) => {
        setOpen(next);
        // A menu that is closed and opened again starts from the question, not
        // from the answer to one nobody gave.
        if (!next) setConfirming(false);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-label="Conversation actions"
        className="broapp-chat-menu__trigger"
        disabled={disabled === true}
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="broapp-chat-menu__content">
        <DropdownMenuItem onSelect={() => onCopy()}>
          <Copy aria-hidden="true" size={15} />
          Copy transcript
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onClear()}>
          <Eraser aria-hidden="true" size={15} />
          Clear chat
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {confirming ? (
          <div className="broapp-chat-menu__confirm">
            <span>Delete this conversation?</span>
            <button
              className="broapp-chat-menu__danger"
              onClick={() => {
                setOpen(false);
                setConfirming(false);
                onDelete();
              }}
              type="button"
            >
              Delete
            </button>
            <button
              className="broapp-chat-menu__cancel"
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        ) : (
          <DropdownMenuItem
            onSelect={(event) => {
              // The menu closes itself on a selection; the second step has to
              // be asked in the menu that is still open.
              event.preventDefault();
              setConfirming(true);
            }}
            variant="destructive"
          >
            <Trash2 aria-hidden="true" size={15} />
            Delete chat
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
