/**
 * A standing answer: the questions a stand-in answers without asking, as pure
 * rules.
 *
 * Two stand-ins read this list. A backlog run answers for the person on its
 * own application's edits, builds and previews (13c); the person's switch,
 * *Work without asking*, answers the engineer's own conversations on the same
 * calls for every application (20a). One list, so the two can never disagree
 * about what "edits, builds and previews" means.
 *
 * The person's switch covers one more thing a run's answer never does: the
 * engineer's two web tools. A search and a page read are `external` — what
 * the model typed leaves the machine — and a person who reads the web through
 * the engineer often found the card before each one was the cost of the tool.
 * So the switch answers them too, and the launcher's log still says so, call
 * by call. A backlog run is not a person and never reads the web unasked.
 *
 * Both lists are closed. Nothing on them widens them: turning the switch on is
 * a launcher route on channel `user` with no engineer tool, and neither
 * activation nor creation is on either.
 */

/**
 * The tools a stand-in may approve without asking.
 *
 * These are what building a change is made of. Not a grant — `launcher.grants*`
 * already means capabilities — and never activation or creation.
 */
export const INTENT_APPROVES: readonly string[] = [
  'source.edit',
  'source.change',
  'candidate.cycle',
  'candidate.build',
  'candidate.preview',
  'preview.stop',
];

/** Refused outright by a backlog run and never put to the person: a builder has no business with them. */
export const INTENT_REFUSES: readonly string[] = ['release.activate', 'apps.create'];

/**
 * The engineer's web tools, which the person's switch covers and a run's
 * answer does not. Named here rather than imported from `web.ts`, so the rule
 * stays a pure module with no tool behind it.
 */
export const STANDING_WEB: readonly string[] = ['web.search', 'web.read'];

/** How the gate's question to a builder's turn is answered. */
export type StandingAnswer = boolean | 'defer';

/**
 * The run's standing answer to one question, as a pure rule.
 *
 * `true` for a listed tool whose input names `appId`; `false` for the two a
 * builder may never have; `'defer'` — put it to the person — for everything
 * else, including a listed tool naming another application.
 */
export function standingAnswer(appId: string, question: { readonly tool: string; readonly input: unknown }): StandingAnswer {
  if (INTENT_REFUSES.includes(question.tool)) return false;
  const named = (question.input as { appId?: unknown } | null | undefined)?.appId;
  if (INTENT_APPROVES.includes(question.tool) && named === appId) return true;
  return 'defer';
}

/**
 * Whether the person's standing approval covers one question.
 *
 * The same list as a run's, with two differences: any application, not one;
 * and the two web tools, which name no application and need none. A listed
 * tool whose input names no application is not covered, because nobody could
 * say which application it is about — and "every application" was a choice
 * about applications, not about calls that name none.
 */
export function standingCovers(tool: string, input: unknown): boolean {
  if (STANDING_WEB.includes(tool)) return true;
  if (!INTENT_APPROVES.includes(tool)) return false;
  const named = (input as { appId?: unknown } | null | undefined)?.appId;
  return typeof named === 'string' && named !== '';
}
