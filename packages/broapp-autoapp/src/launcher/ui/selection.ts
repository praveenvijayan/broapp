/**
 * Which application the launcher's page selects when nothing is selected yet.
 *
 * The one the person last chose, when it is still listed, else the first row.
 * Before 14a it was always the first row, while the engineer's turns and the
 * session went on naming the one the person had chosen: the Backlog panel
 * opened on another application's empty backlog, and looked broken until the
 * right row was clicked.
 */
export function firstSelection(rows: readonly { readonly appId: string }[], remembered: string | null | undefined): string | null {
  if (remembered !== null && remembered !== undefined && rows.some((row) => row.appId === remembered)) return remembered;
  return rows[0]?.appId ?? null;
}
