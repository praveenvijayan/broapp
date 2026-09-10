# broapp-autoapp

Autoapp turns a Broapp application into one its owner can reshape while using
it: a launcher that supervises applications, a renderer that draws a
declarative view specification, and an AI engineer that proposes changes as
candidate releases. Everything an application's owner approves is built and
run by a child process as **trusted local code** — crash-isolated, not
permission-isolated, running with the owner's own permissions. See
[the design](../../docs/autoapp/design.md).

A launcher that has just been downloaded starts with nothing, so it carries a
starter application inside its own binary: **New application** in its tab —
and `broapp-autoapp create <appId>`, and the engineer's `apps.create` — writes
that workspace to disk, installs its dependencies, builds the first release
and opens it. What comes out is an ordinary source workspace, indistinguishable
from one you imported yourself.
