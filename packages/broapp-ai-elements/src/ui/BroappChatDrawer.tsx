/**
 * The panel as a drawer at the right edge of the window.
 *
 * The application keeps its own layout: no backdrop, no scroll lock, nothing
 * captured. A person can read the page beside the conversation, which for the
 * Autoapp launcher — where the assistant is asked about the table it is
 * sitting next to — is the whole point.
 */
import * as React from 'react';

import { ChevronRight, Copy, MessageSquare, Trash2 } from 'lucide-react';

import { BroappChat } from './BroappChat.tsx';
import type { BroappChatControls, BroappChatProps } from './BroappChat.tsx';

/** Props for {@link BroappChatDrawer}. */
export interface BroappChatDrawerProps extends BroappChatProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** Header text, and the drawer's accessible name. Default "Chat". */
  readonly title?: string;
  /** One paragraph under the title, e.g. what the assistant can do. */
  readonly description?: string;
  /**
   * Key that toggles the drawer with ⌘ on macOS, Ctrl elsewhere. Default "i".
   * Set to `null` to bind nothing.
   */
  readonly shortcutKey?: string | null;
  /** CSS width. Default "26rem"; full width under 40rem viewports. */
  readonly width?: string;
}

/** Whether ⌘ or Ctrl is the modifier here. Unknown — a server — means ⌘. */
function onApple(): boolean {
  if (typeof navigator === 'undefined') return true;
  const agent = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = agent.userAgentData?.platform ?? navigator.platform;
  return platform === undefined || /mac|iphone|ipad|ipod/i.test(platform);
}

/** How the shortcut is written for a reader: `⌘ I` or `Ctrl I`. */
function shortcutLabel(key: string): string {
  return `${onApple() ? '⌘' : 'Ctrl'} ${key.toUpperCase()}`;
}

/** Props for {@link BroappChatToggle}. */
export interface BroappChatToggleProps {
  readonly open: boolean;
  onToggle(): void;
  /** Default "Ask AI". */
  readonly label?: string;
  /** Shown in a `<kbd>` beside the label. Default "i"; `null` shows none. */
  readonly shortcutKey?: string | null;
}

/** The button that opens the drawer. Lives in the application's own header. */
export function BroappChatToggle({
  open,
  onToggle,
  label = 'Ask AI',
  shortcutKey = 'i',
}: BroappChatToggleProps): React.ReactElement {
  return (
    <button
      aria-expanded={open}
      className="broapp-chat-toggle"
      onClick={onToggle}
      type="button"
    >
      <MessageSquare aria-hidden="true" size={15} />
      {label}
      {shortcutKey === null ? null : <kbd>{shortcutLabel(shortcutKey)}</kbd>}
    </button>
  );
}

export function BroappChatDrawer({
  open,
  onOpenChange,
  title = 'Chat',
  description,
  shortcutKey = 'i',
  width = '26rem',
  ...chat
}: BroappChatDrawerProps): React.ReactElement {
  const controls = React.useRef<BroappChatControls | null>(null);
  const aside = React.useRef<HTMLElement | null>(null);
  // Where focus was when the drawer opened, so closing it can put it back.
  const restore = React.useRef<Element | null>(null);

  // The shortcut is on the window: a person reaches for it while reading the
  // page, which is exactly when nothing inside the drawer has focus.
  React.useEffect(() => {
    if (shortcutKey === null) return undefined;
    const key = shortcutKey.toLowerCase();
    const onKeyDown = (event: KeyboardEvent): void => {
      // Held keys repeat; a drawer that flickered while a key was down would
      // be answering an intention nobody had.
      if (event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== key) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutKey, open, onOpenChange]);

  React.useEffect(() => {
    if (open) {
      restore.current = document.activeElement;
      // The one thing a person opened the drawer to do.
      aside.current?.querySelector('textarea')?.focus();
      return;
    }
    const previous = restore.current;
    restore.current = null;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }, [open]);

  const copy = React.useCallback((): void => {
    void navigator.clipboard?.writeText(controls.current?.transcript() ?? '');
  }, []);

  return (
    <aside
      aria-label={title}
      className="broapp-chat-drawer"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onOpenChange(false);
      }}
      ref={aside}
      role="complementary"
      // Inline as a custom property, so the narrow-viewport rule in the
      // stylesheet can still take the drawer to full width.
      style={{ '--broapp-chat-drawer-width': width } as React.CSSProperties}
    >
      <div className="broapp-chat-drawer__header">
        <h2 className="broapp-chat-drawer__title">{title}</h2>
        <button
          aria-label="Copy transcript"
          className="broapp-chat-drawer__action"
          onClick={copy}
          title="Copy transcript"
          type="button"
        >
          <Copy aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Clear conversation"
          className="broapp-chat-drawer__action"
          onClick={() => controls.current?.clear()}
          title="Clear conversation"
          type="button"
        >
          <Trash2 aria-hidden="true" size={16} />
        </button>
        <button
          aria-label="Close"
          className="broapp-chat-drawer__action"
          onClick={() => onOpenChange(false)}
          title="Close"
          type="button"
        >
          <ChevronRight aria-hidden="true" size={16} />
        </button>
      </div>
      {description === undefined ? null : (
        <p className="broapp-chat-drawer__description">{description}</p>
      )}
      <div className="broapp-chat-drawer__body">
        {/*
          Rendered whether the drawer is open or not, and hidden with the
          aside's `hidden` attribute rather than unmounted: a turn takes a
          model as long as it takes, and closing the drawer to keep reading
          the page must not throw the answer away.
        */}
        <BroappChat
          {...chat}
          controlsRef={controls}
          frame="plain"
          {...(shortcutKey === null
            ? {}
            : { suggestionTip: `Tip: you can open and close chat with ${shortcutLabel(shortcutKey)}` })}
        />
      </div>
    </aside>
  );
}
