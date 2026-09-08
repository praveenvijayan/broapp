/**
 * The conversations, newest first, grouped by the day they last changed.
 *
 * Pure: it draws a list and reports what was clicked. Everything it shows —
 * the titles the host derived, the model a conversation was pinned to — comes
 * from `useAiThreads`, and the caller is what holds that.
 */
import * as React from 'react';

import { MoreHorizontal, PanelLeftClose, Pencil, Plus, Trash2 } from 'lucide-react';

import type { Thread } from 'broapp/ai';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx';

/** Props for {@link BroappThreadList}. */
export interface BroappThreadListProps {
  readonly threads: readonly Thread[];
  readonly activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  readonly loading?: boolean;
  readonly emptyText?: string;
  /** Drawn as a collapse button when given; nothing is drawn without it. */
  readonly onCollapse?: () => void;
  /** For the day grouping. Default `Date.now()`, which is what a browser wants. */
  readonly now?: number;
}

/** The three buckets, in the order they are shown. */
const GROUPS = ['Today', 'Yesterday', 'Earlier'] as const;
type Group = (typeof GROUPS)[number];

/**
 * Which bucket a moment belongs in, against local midnight.
 *
 * Calendar days, not elapsed hours: something written at 23:50 is "yesterday"
 * at 00:10 the next morning, which is how a person reads their own list.
 */
function groupOf(updatedAt: number, now: number): Group {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (updatedAt >= midnight.getTime()) return 'Today';
  return updatedAt >= midnight.getTime() - 86_400_000 ? 'Yesterday' : 'Earlier';
}

/** One row's `…` menu. Rename opens the inline field; Delete is immediate. */
function RowMenu({
  title,
  onRename,
  onDelete,
}: {
  title: string;
  onRename(): void;
  onDelete(): void;
}): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${title}`}
        className="broapp-chat-threads__action"
        // A click on the menu must not also select the row underneath it.
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="broapp-chat-menu__content">
        <DropdownMenuItem onSelect={() => onRename()}>
          <Pencil aria-hidden="true" size={15} />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDelete()} variant="destructive">
          <Trash2 aria-hidden="true" size={15} />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BroappThreadList({
  threads,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  loading,
  emptyText = 'No conversations yet.',
  onCollapse,
  now,
}: BroappThreadListProps): React.ReactElement {
  // Which row is being renamed, and the draft in its field. One at a time:
  // two open fields would be two answers to "what is this called".
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  // Read once per render rather than per row, so every row of one render is
  // grouped against the same moment.
  const at = now ?? Date.now();

  const commit = (id: string): void => {
    const title = draft.trim();
    setRenaming(null);
    if (title !== '') onRename(id, title);
  };

  const rows = new Map<Group, Thread[]>(GROUPS.map((group) => [group, []]));
  for (const thread of threads) rows.get(groupOf(thread.updatedAt, at))?.push(thread);

  return (
    <div className="broapp-chat-threads">
      <div className="broapp-chat-threads__header">
        <h2 className="broapp-chat-threads__title">History</h2>
        <button
          aria-label="New conversation"
          className="broapp-chat-threads__action"
          onClick={onNew}
          title="New conversation"
          type="button"
        >
          <Plus aria-hidden="true" size={15} />
        </button>
        {onCollapse === undefined ? null : (
          <button
            aria-label="Hide the conversations"
            className="broapp-chat-threads__action"
            onClick={onCollapse}
            title="Hide the conversations"
            type="button"
          >
            <PanelLeftClose aria-hidden="true" size={15} />
          </button>
        )}
      </div>

      {threads.length === 0 ? (
        <p className="broapp-chat-threads__empty">
          {loading === true ? 'Reading the conversations…' : emptyText}
        </p>
      ) : null}

      {GROUPS.map((group) => {
        const inGroup = rows.get(group) ?? [];
        if (inGroup.length === 0) return null;
        return (
          <section className="broapp-chat-threads__group" key={group}>
            <h3 className="broapp-chat-threads__group-title">{group}</h3>
            {inGroup.map((thread) => (
              <div
                aria-current={thread.id === activeId}
                className={`broapp-chat-threads__row${
                  thread.id === activeId ? ' broapp-chat-threads__row--active' : ''
                }`}
                key={thread.id}
              >
                {renaming === thread.id ? (
                  <input
                    aria-label={`Rename ${thread.title}`}
                    autoFocus
                    className="broapp-chat-threads__rename"
                    onBlur={() => commit(thread.id)}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commit(thread.id);
                      }
                      // Escape abandons the draft; the title is what it was.
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                    value={draft}
                  />
                ) : (
                  <>
                    <button
                      className="broapp-chat-threads__select"
                      onClick={() => onSelect(thread.id)}
                      type="button"
                    >
                      <span className="broapp-chat-threads__name">{thread.title}</span>
                      {thread.modelId === null ? null : (
                        <span className="broapp-chat-threads__model">{thread.modelId}</span>
                      )}
                    </button>
                    <RowMenu
                      onDelete={() => onDelete(thread.id)}
                      onRename={() => {
                        setDraft(thread.title);
                        setRenaming(thread.id);
                      }}
                      title={thread.title}
                    />
                  </>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
