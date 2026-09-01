# Distribution

## User-local shell installer

The Bash installer downloads a GitHub source archive over TLS, builds it with npm, and atomically switches `~/.local/share/mar/current`. It links `mar` into `~/.local/bin` and does not require root privileges.

```bash
curl -fsSL https://raw.githubusercontent.com/kudasaixc/mar/main/install.sh | bash
```

Controls:

```bash
MAR_VERSION=0.1.0 bash install.sh
MAR_INSTALL_DIR="$HOME/apps/mar" MAR_BIN_DIR="$HOME/bin" bash install.sh
bash install.sh --uninstall
```

Uninstall permanently removes the selected MAR install root and its executable symlink. Configuration and session history are intentionally preserved.

## Package managers

Install directly from GitHub today:

```bash
npm install -g https://github.com/kudasaixc/mar/archive/refs/heads/main.tar.gz
pnpm add -g https://github.com/kudasaixc/mar/archive/refs/heads/main.tar.gz
yarn global add https://github.com/kudasaixc/mar/archive/refs/heads/main.tar.gz
bun add -g https://github.com/kudasaixc/mar/archive/refs/heads/main.tar.gz
```

After npm publication:

```bash
npm install -g @kudasaixc/mar
pnpm add -g @kudasaixc/mar
yarn global add @kudasaixc/mar
bun add -g @kudasaixc/mar
```

## Maintainer release

1. Update `package.json` and `CHANGELOG.md`.
2. Run `npm ci && npm test && git diff --exit-code -- dist && npm pack --dry-run`.
3. Tag the commit as `vX.Y.Z` and push the tag.
4. The release workflow tests the exact source, creates an npm tarball, and attaches it to a GitHub Release.
5. If the repository secret `NPM_TOKEN` exists, the workflow also publishes the public package with npm provenance.
