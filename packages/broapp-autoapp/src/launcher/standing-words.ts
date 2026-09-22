/**
 * Every sentence about the person's standing approval, *Work without asking*.
 *
 * One module, so the Settings switch, the card's third button, the top bar,
 * the Overview, the routes and the command line say the same thing in the
 * same words. It imports nothing from `node:`: the page draws these, and a
 * module the page bundles cannot reach the file system.
 */

export const STANDING_WORDS = {
  /** The Settings section the switch sits in. */
  sectionTitle: 'The engineer',
  /** The switch's label. */
  switchLabel: 'Work without asking',
  /** Under the switch: what it covers, and what it never does. */
  hint:
    'Edits, builds and previews of any application are approved for the engineer without asking. Activation, creating or removing an application, and anything that reaches outside still ask.',
  /** The card's third button, beside Allow and Decline. */
  cardLabel: 'Allow, and stop asking',
  /** The conversation's top bar while it is on. */
  topBarLine: 'Working without asking',
  /** Beside the top bar's line: turns it off. */
  askAgain: 'Ask again',
  /** One muted line on the Overview while it is on. */
  overviewLine: 'The engineer works without asking',
  /** A route asked by anyone but a person in the launcher's own tab. */
  onlyAPerson: 'Only a person turns working without asking on or off, from the launcher.',
  /** A write that did not reach the disk. */
  notSaved: (reason: string): string => `Working without asking could not be changed: ${reason}`,
  /** The launcher's log, one event per question the standing approval answered. */
  approved: (tool: string, appId: string): string => `the standing approval approved ${tool} for ${appId}`,
  /** The launcher's log, one event per change of the switch. */
  turned: (on: boolean): string => `the person turned working without asking ${on ? 'on' : 'off'}`,
  /** The command line's answer, and `status`'s line after `standing: `. */
  state: (standing: boolean, since: number | null): string =>
    standing ? `on since ${since === null ? 'an unknown time' : new Date(since).toISOString()}` : 'off',
} as const;
