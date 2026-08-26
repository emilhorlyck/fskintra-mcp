# Home Assistant add-on image for fskintra-mcp.
#
# Built on the official Node 24 image rather than a Home Assistant base image.
# Node is here for the dependency install: pnpm 10 needs node >=22.13, and 24 is
# the active LTS line. The upper bound matters too — Corepack ships with Node
# "from 14.19.0 up to (but not including) 25.0.0", so `corepack enable` below
# breaks on Node 25+. Bumping past 24 means installing pnpm some other way.
#
# The server itself needs Bun at runtime (it exports a Bun-style default server
# object and runs .ts directly), so Bun is copied in separately.
#
# Supervisor uses this directory as the Docker build context, which means files
# elsewhere in the monorepo cannot be referenced with `COPY ../packages`. The
# repository is therefore cloned during the build. FSKINTRA_MCP_REF selects the
# branch or tag; pin it in build.yaml for reproducible releases.
FROM node:24-bookworm-slim

ARG FSKINTRA_MCP_REF=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy Bun out of the official image rather than piping bun.sh/install into a
# shell: that script is unpinned, so every rebuild would pull whatever Bun is
# current and could break the runtime on a user's reinstall.
COPY --from=oven/bun:1.4-debian /usr/local/bin/bun /usr/local/bin/bun

# Pre-activating the pinned pnpm warms the Corepack cache here instead of
# mid-install, and fails the build loudly if the pin drifts from package.json.
RUN corepack enable \
  && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

RUN git clone --depth 1 --branch "${FSKINTRA_MCP_REF}" \
  https://github.com/emilhein/fskintra-mcp.git .

RUN pnpm install --frozen-lockfile

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 7979

CMD ["/run.sh"]
