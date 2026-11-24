#!/usr/bin/env bash
#
# Deploy the site on the VPS: fetch, install, build, restart, smoke-test.
#
# Runs as the `checkclimate` user (the app's own user). It needs no password:
# the only privileged step is the restart, and the sudo rule in
# deploy/sudoers-checkclimate allows exactly that one command.
#
#   bash scripts/deploy-vps.sh                    # deploy main
#   DEPLOY_BRANCH=vps bash scripts/deploy-vps.sh  # deploy another branch
#   bash scripts/deploy-vps.sh --check            # build, but do not restart
#
# GitHub Actions runs it through a forced command in ~/.ssh/authorized_keys,
# so a push to main deploys main (docs/vps-runbook.md, "Deploy a change").
#
# What it does NOT do: migrate the database, touch the media, or change
# anything outside /home/checkclimate/app. EmDash migrates the database
# itself on the first request after the restart, and the media stays in R2.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/checkclimate/app}"
BUILD_ENV="${BUILD_ENV:-/etc/checkclimate.build.env}"
SERVICE="${SERVICE:-checkclimate.service}"
BRANCH="${DEPLOY_BRANCH:-main}"
PORT_TO_CHECK="${PORT:-4331}"
CHECK_ONLY=0

if [ "${1:-}" = "--check" ]; then
	CHECK_ONLY=1
fi

cd "$APP_DIR"

# Node 24 is installed for this user only (fnm). fnm's default alias is a
# stable link to it, so put that on the PATH directly: a forced-command SSH
# login is not a login shell and never reads ~/.profile. corepack's pnpm shim
# lives in the same bin directory.
NODE_BIN="$HOME/.local/share/fnm/aliases/default/bin"
if [ -d "$NODE_BIN" ]; then
	export PATH="$NODE_BIN:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
	echo "node is not on the PATH. Install Node 24 for the $USER user (docs/vps-runbook.md)." >&2
	exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
	echo "pnpm is not on the PATH. Run: corepack enable pnpm (docs/vps-runbook.md)." >&2
	exit 1
fi

echo "==> Node $(node --version), pnpm $(pnpm --version)"

if [ -n "$(git status --porcelain)" ]; then
	git status --short
	echo "    the working tree has changes; this checkout must stay clean" >&2
	exit 1
fi

echo "==> Fetch $BRANCH"
before="$(git rev-parse HEAD)"
git fetch --quiet origin "$BRANCH"
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
	echo "==> Switch to $BRANCH"
	git switch --quiet "$BRANCH" 2>/dev/null || git switch --quiet -c "$BRANCH" --track "origin/$BRANCH"
fi
git merge --ff-only --quiet "origin/$BRANCH"
echo "    $(git log -1 --format='%h %s')"

# A branch without this script is not a VPS build (main, until the migration
# merges, is the Workers site). Go back and refuse rather than build it.
if [ ! -f scripts/deploy-vps.sh ]; then
	echo "    $BRANCH has no scripts/deploy-vps.sh: not a VPS build, not deploying" >&2
	git switch --quiet - 2>/dev/null || git switch --quiet --detach "$before"
	exit 1
fi

# Bash reads a script as it runs, from the copy it opened, so an update that
# changes this file would otherwise run the OLD steps for the rest of this
# deploy. Start over on the new copy, once (DEPLOY_REEXEC stops a loop).
if [ -z "${DEPLOY_REEXEC:-}" ] && ! git diff --quiet "$before" HEAD -- scripts/deploy-vps.sh; then
	echo "==> The deploy script changed; restarting it"
	DEPLOY_REEXEC=1 exec bash "$APP_DIR/scripts/deploy-vps.sh" "$@"
fi

echo "==> Install dependencies"
pnpm install --frozen-lockfile

# The site URL, database path and session directory are baked into the bundle
# at build time (astro.config.mjs). The secrets are not needed here: they are
# read at runtime from /etc/checkclimate.env.
if [ ! -r "$BUILD_ENV" ]; then
	echo "    $BUILD_ENV is missing; refusing to build with laptop defaults" >&2
	exit 1
fi
echo "==> Build (configuration from $BUILD_ENV)"
set -a
# shellcheck disable=SC1090
. "$BUILD_ENV"
set +a
pnpm build:vps

# An interrupted build can leave no server entry; don't restart into that.
if [ ! -f dist/server/entry.mjs ]; then
	echo "    dist/server/entry.mjs is missing; the build did not finish" >&2
	exit 1
fi

if [ "$CHECK_ONLY" = "1" ]; then
	echo "==> Build OK (not restarting: --check)"
	exit 0
fi

echo "==> Restart $SERVICE"
sudo systemctl restart "$SERVICE"

# Smoke test on the origin itself: from GitHub's runners the site sits behind
# Cloudflare's bot rules. 127.0.0.1 is one of the middleware's own hosts, so
# it is served, not redirected to the apex.
code=000
for _ in $(seq 1 20); do
	code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_TO_CHECK}/" || true)
	[ "$code" = "200" ] && break
	sleep 3
done
if [ "$code" != "200" ]; then
	echo "    the site answers $code on 127.0.0.1:${PORT_TO_CHECK} after the restart" >&2
	# No sudo: reading the journal of a unit needs the user to be in the
	# systemd-journal/adm group; if not, this prints nothing and that is fine.
	journalctl -u "$SERVICE" -n 20 --no-pager 2>/dev/null || true
	systemctl status "$SERVICE" --no-pager --lines=0 || true
	exit 1
fi
echo "Deployed $(git log -1 --format='%h') on $BRANCH: the site answers 200 on 127.0.0.1:${PORT_TO_CHECK}"
