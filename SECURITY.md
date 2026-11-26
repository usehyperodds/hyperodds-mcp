# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Either:
- use **Report a vulnerability** under this repository's
  [Security tab](https://github.com/usehyperodds/hyperodds-mcp/security/advisories/new), or
- email security@usehyperodds.com.

Include what you found, how to reproduce it and what an attacker could do with it. We aim to
reply within three working days, keep you updated while we fix it, and credit you in the advisory
unless you would rather we did not.

## Scope

- This package, `@hyperodds/mcp`, and the Claude Desktop extension built from it, `hyperodds.mcpb`,
  including how they keep the forecaster key and what they sign.
- The hosted MCP endpoint it talks to, `https://api.usehyperodds.com/mcp`.

Report problems in the console at usehyperodds.com the same way. Issues in Hyperliquid,
Polymarket, Kalshi or other third parties belong with them.

## The forecaster key

The bridge keeps the forecaster key in `~/.config/hyperodds/forecaster.key` on macOS and Linux
(`$XDG_CONFIG_HOME/hyperodds/forecaster.key` when it is set), and in
`%APPDATA%\hyperodds\forecaster.key` on Windows. It makes the file with mode 600, in a folder with
mode 700.

On macOS and Linux, the bridge opens the file without following a link and without waiting on a
FIFO, checks the open file before it reads the key from it, and refuses the key, with the fix, when:
- the file is not a regular file, or is over 1 KB;
- the file belongs to another user, or its group or other users can read or write it;
- the file, the `hyperodds` folder or the config folder above it (`~/.config` or
  `$XDG_CONFIG_HOME`) is a symbolic link;
- the file has more than one hard link;
- the `hyperodds` folder belongs to another user, or its group or other users can write to it.

The folder checks run before the bridge makes a key as well, so it makes none through a link or in
a folder others control. Folders above the config folder are not checked, since system folders are
often links themselves, like `/var` on macOS and `/home` on Fedora Silverblue.

The same folder checks run before every read and save of `forecast-times.json`, the file beside
the key that holds the time of the last forecast signed on each market, whichever way the key is
given. The bridge reads that file only if it is a regular file of at most 1 MB, opened without
following a link, and saves it under a new name that it then renames into place, so a link there
is replaced, never written through. A time in it more than 10 minutes ahead of this computer's
clock counts as 10 minutes ahead, and the bridge never signs a time further ahead than that.

On Windows, the bridge makes none of these checks, and the key relies on the permissions of
`%APPDATA%`, which the computer's administrators can read.

`HYPERODDS_FORECAST_KEY_FILE` names a key file of your own instead, by its absolute path. The
bridge runs the same checks on that file, its folder and the folder above, and never makes a key
there: if the file is missing, it refuses to sign. The forecast times stay in the default folder.

A key set in `HYPERODDS_FORECAST_KEY` is used in place of any file. The bridge reads it once at
startup and deletes it from its own environment (`process.env`), so nothing later in the process
finds it there. That does not erase it: the key stays in the client's config, and the operating
system keeps the environment the bridge started with, which processes running as the same user,
and administrators, can read (on Linux, `/proc/<pid>/environ`). The extension passes its
**Forecaster key** setting this way. Setting both variables is refused at startup.

## Supported versions

Fixes go into the latest release. The client entries in the README pin a version, so to upgrade,
change it to the newest release in the [changelog](CHANGELOG.md). An entry with
`@hyperodds/mcp@latest` instead gets the newest release each time the client starts the bridge.

An extension installed from a file does not update itself. To upgrade the Claude Desktop
extension, download `hyperodds.mcpb` from the
[latest release](https://github.com/usehyperodds/hyperodds-mcp/releases/latest) and open it. The
[README](https://github.com/usehyperodds/hyperodds-mcp#quick-start) shows how to check the file
first.
