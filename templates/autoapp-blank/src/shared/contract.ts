/**
 * What this application can be asked to do: nothing, yet.
 *
 * An empty contract is a legal one. `defineContract` checks the names and the
 * effects of the routes it is given and is content to be given none, and a
 * release with no operations still serves its page — what the browser draws
 * comes from `views.ts`, and the renderer's own routes belong to the framework
 * rather than to this file.
 *
 * The first route goes here, with an `effect` (`read`, `write` or `external`)
 * and a `summary`: a release refuses a route without them, because the effect
 * is what the gate reads when it decides whether to ask, and the summary is
 * what a person is shown when it does.
 */
import { defineContract } from 'broapp/shared';

export const contract = defineContract({
  operations: {},
  streams: {},
});
