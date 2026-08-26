# Home Assistant add-on image for fskintra-mcp.
#
# Built straight on the official Bun image. Bun is both the package manager and
# the runtime here, so there is no Node or Corepack layer to keep in sync — the
# reason the aula-mcp add-on this is modelled on needs one is that it predates
# Bun's isolated installer.
#
# The tag is pinned rather than tracking latest: an add-on rebuild happens on
# the user's schedule, not ours, and a runtime that changes underneath a working
# install is a bad surprise on a box nobody is watching.
#
# Supervisor uses this directory as the Docker build context, which means files
# elsewhere in the monorepo cannot be referenced with `COPY ../packages`. The
# repository is therefore cloned during the build. FSKINTRA_MCP_REF selects the
# branch or tag; pin it in build.yaml for reproducible releases.
FROM oven/bun:1.4-debian

ARG FSKINTRA_MCP_REF=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --depth 1 --branch "${FSKINTRA_MCP_REF}" \
  https://github.com/emilhein/fskintra-mcp.git .

RUN bun install --frozen-lockfile --production

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 7979

CMD ["/run.sh"]
