# create-broapp

Scaffold a local application built on Bun, a browser UI, and
[Brobridge](https://github.com/praveenvijayan/brobridge).

```bash
bun create broapp my-app
cd my-app
bun run dev
```

You get a working application: a typed call to the host, a cancellable progress
stream, honest connection states, and `bun run build` producing a single
executable that runs on a machine with no Bun installed.

## Options

```
bun create broapp <directory> [options]

  --name <name>         Package and executable name. Default: from <directory>.
  --title <title>       Name shown in the interface. Default: the name.
  --description <text>  One line for package.json.
  --broapp <range>      Version range for the "broapp" dependency.
  --no-install          Skip "bun install". Works with no network.
  --git                 Run "git init" and make one commit. Off by default.
  --yes                 Accept every default; never prompt.
  -h, --help
  -v, --version
```

Interactive when stdin is a terminal, non-interactive otherwise — so it does not
hang in a script.

## What it will not do

- Overwrite a directory that is not empty.
- Write outside the current directory unless you give an absolute path.
- Accept a name that is illegal on npm or unsafe as a filename.
- Initialise a Git repository unless you pass `--git`.
- Delete anything that was already there if it fails part-way.

## Requirements

Bun 1.2 or newer.

Full documentation: <https://github.com/praveenvijayan/broapp>.

## Licence

MIT.
