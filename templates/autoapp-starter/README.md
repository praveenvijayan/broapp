# __APP_NAME__

__APP_DESCRIPTION__

This is a Broapp application the Autoapp launcher created from its built-in
starter. It is an ordinary source workspace: everything the launcher can do to
an application you imported yourself, it can do to this one.

## What it is

A list of items. Each has a label, a note, a done flag and the time it was
added. Five routes — `items.list`, `items.add`, `items.update`, `items.remove`
and `items.status` — over one SQLite table, drawn by the pinned renderer from
`src/shared/views.ts`.

The route group stays `items` whatever this application is called. A name is
data; a route group is code.

## Where things are

| Path | What it is |
|---|---|
| `autoapp.json` | The manifest: id, name, schema version, migrations, acceptance examples, capabilities. |
| `src/shared/contract.ts` | The routes, each with an `effect` and a `summary`. |
| `src/shared/views.ts` | The interface, as data. No generated browser code, ever. |
| `src/host/app.ts` | `start` and `migrate`. |
| `src/host/db.ts` | The SQLite table and its migrations. |
| `src/ui/` | The browser entry, the document and the palette. |

Your data is not here. It lives in the launcher's own directory, under
`apps/__APP_ID__/data/`, and this workspace is only the source it is built
from. A preview runs against a copy of that data, never against the original.

## No AI panel in this tab

The engineer is in the launcher's tab, not in this one. An AI panel here would
pull in `broapp-ai-elements` and the provider packages — roughly three times
what installing this application has to fetch — for something you have not
asked for. If you want one later, ask the engineer to add it.

## Changing it

Open the launcher, select this application, and describe the change. The
engineer edits this workspace, builds a candidate release, and shows you a
preview running on a copy of your data before anything is replaced.

You can also edit the workspace by hand and build it yourself:

```
broapp-autoapp build __APP_ID__
broapp-autoapp activate __APP_ID__ <releaseId>
```

To typecheck it by hand, install the development dependencies first — creation
installs only what the application needs to run:

```
bun install
bun run typecheck
```

Migrations are appended and never edited. One that has already run against your
data is history; changing it means the database and the list in `autoapp.json`
disagree for ever.

An application runs as trusted local code: crash isolated from the launcher,
not permission isolated from you.
