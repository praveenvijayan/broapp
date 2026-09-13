# broapp-autoapp

Autoapp turns a Broapp application into one its owner can reshape while using
it: a launcher that supervises applications, a renderer that draws a
declarative view specification, and an AI engineer that proposes changes as
candidate releases. Everything an application's owner approves is built and
run by a child process as **trusted local code** — crash-isolated, not
permission-isolated, running with the owner's own permissions. See
[the design](../../docs/autoapp/design.md).

A launcher that has just been downloaded starts with nothing, so it carries two
starter applications inside its own binary: **New application** in its tab —
and `broapp-autoapp create <appId> [--template starter|blank]`, and the
engineer's `apps.create` — writes one of them to disk, installs its
dependencies, builds the first release and opens it. `starter`, the default, is
a list of items with a table and a form; `blank` is one empty page to describe
to the engineer. What comes out is an ordinary source workspace,
indistinguishable from one you imported yourself.

`broapp-autoapp remove <appId> --yes`, and **Remove** on the row in the tab,
move an application's whole directory — releases, source workspace and data —
into `<root>/trash/`. Nothing is deleted, the launcher never empties that
directory, and nothing is removed while the application is running.

The **Knowledge** panel in the tab shows what the launcher remembers: each
engineer turn with what it was given and what became of each lesson served,
the lessons with their provenance, and the cases; a person confirms, retires,
writes or replaces a lesson there, writing the same rows `broapp-autoapp
knowledge confirm|retire` write. See [what the launcher remembers](../../docs/autoapp/learning.md).
