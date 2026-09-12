/**
 * What this application looks like, as data.
 *
 * One page with one sentence on it. The browser runs the pinned renderer over
 * this specification; there is no generated browser code anywhere in an Autoapp
 * application, here or after the engineer has filled this file in.
 *
 * The page's `title` is the application's name, substituted when this workspace
 * was written. It is the one place a name may appear in a `.ts` file — the
 * starter avoids that entirely, because a name containing a quote inside a
 * TypeScript string literal would produce a file that does not parse, and this
 * template's substitution is JSON-escaped for exactly that reason. Change it to
 * whatever the page should be called; nothing reads it but the renderer.
 *
 * Components keep their `id` across changes: a person's own customisations key
 * on it, and renaming one throws their work away.
 */
import type { ViewsSpec } from 'broapp-autoapp/shared';

export const views: ViewsSpec = {
  specVersion: 1,
  home: 'home',
  pages: [
    {
      id: 'home',
      // Double-quoted on purpose: this is the one marker in a TypeScript file
      // in either template, and `writeStarter` encodes a `.ts` value the way it
      // encodes a JSON one — which is exactly what a double-quoted literal
      // wants. A name with a quote in it lands here intact.
      title: "__APP_NAME__",
      sources: [],
      children: [
        {
          id: 'welcome',
          kind: 'text',
          template: 'Nothing here yet. Tell the engineer what this application should do.',
        },
      ],
    },
  ],
};
