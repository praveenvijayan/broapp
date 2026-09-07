/**
 * What an application's interface is, as data.
 *
 * The browser never runs generated JavaScript. That is the constraint the
 * whole file follows from: whatever an AI engineer proposes has to be
 * expressible here, in JSON, with no expressions, no HTML and no URLs — and
 * whatever cannot be expressed here cannot be proposed. A page's CSP is pinned
 * to the hashes the build computed, so there is nowhere for generated script to
 * go even if something tried to put it there.
 *
 * Components are keyed by a stable `id`. Overrides key on it, and so does the
 * engineer's preview, so an edit that renames an id silently discards a
 * person's customisations. The engineer is told to keep them.
 */

/** The only view-specification version there is. */
export const VIEWS_VERSION = 1 as const;

/** Path into a JSON value: dot-separated keys and numeric indexes. `notes.0.title`. */
export type Path = string;

/** How a value is turned into text. */
export type Format = 'text' | 'number' | 'boolean' | 'datetime';

/** One application's whole interface. */
export interface ViewsSpec {
  readonly specVersion: typeof VIEWS_VERSION;
  readonly pages: readonly Page[];
  /** Page id shown first. */
  readonly home: string;
}

/** One screen. */
export interface Page {
  /** `[a-z][a-z0-9-]*`, unique across pages. */
  readonly id: string;
  readonly title: string;
  /** Route parameters the page takes, from the URL hash, in order. */
  readonly params?: readonly string[];
  /** Operations loaded when the page opens, in order. */
  readonly sources?: readonly Source[];
  readonly children: readonly Component[];
}

/** One operation whose result the page's components read. */
export interface Source {
  /** Unique within the page. */
  readonly id: string;
  /** A route in the contract with effect `read`. */
  readonly operation: string;
  /** Literal input; a string `$param.<name>` is replaced by the page parameter. */
  readonly input?: unknown;
}

/** One thing on a page. */
export interface Component {
  readonly id: string;
  readonly kind: 'section' | 'text' | 'table' | 'form' | 'button' | 'status';
  readonly label?: string;
  readonly hidden?: boolean;

  /** `section`. */
  readonly children?: readonly Component[];

  /** `text`: may contain `{{sourceId.path}}` placeholders, and nothing else. */
  readonly template?: string;

  /** `table` and `status`: which source to read. */
  readonly source?: string;
  /** `table`: path to the array inside the source's output. */
  readonly rows?: Path;
  readonly columns?: readonly Column[];
  readonly rowActions?: readonly Action[];
  readonly emptyText?: string;

  /** `form`. */
  readonly fields?: readonly Field[];
  readonly submit?: Action;

  /** `button`. */
  readonly action?: Action;

  /** `status`: which value inside the source to show. */
  readonly path?: Path;
  readonly format?: Format;
}

/** One column of a table. */
export interface Column {
  readonly id: string;
  readonly header: string;
  readonly path: Path;
  readonly format?: Format;
  readonly width?: 'narrow' | 'normal' | 'wide';
  /** Clicking the cell navigates to this page, with params drawn from the row by path. */
  readonly link?: { readonly page: string; readonly params: readonly Path[] };
}

/** One input in a form. */
export interface Field {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'textarea' | 'number' | 'boolean';
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  /** Initial value: literal, or `$param.<name>`, or `$source.<sourceId>.<path>`. */
  readonly initial?: unknown;
}

/** One thing a person can do. */
export interface Action {
  readonly id: string;
  readonly label: string;
  /** Any route; its effect decides whether the gate asks. */
  readonly operation: string;
  /**
   * How to build the operation's input. Keys are input fields. Values are
   * literals, or the strings `$param.<name>`, `$field.<fieldId>`,
   * `$row.<path>`, `$source.<sourceId>.<path>`.
   */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Ask before running. Required when the operation's effect is not `read`. */
  readonly confirmText?: string;
  /** Source ids to reload after success. */
  readonly refresh?: readonly string[];
  /** Navigate after success. */
  readonly then?: { readonly page: string; readonly params?: readonly string[] };
}
