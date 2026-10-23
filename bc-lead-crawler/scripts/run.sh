#!/bin/sh
# Runs a TypeScript entry point. In Claude cloud sessions, routes Node's fetch through the session's HTTPS proxy.
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ]; then export NODE_USE_ENV_PROXY=1; fi
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f /root/.ccr/ca-bundle.crt ]; then export NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt; fi
export NODE_NO_WARNINGS=1
exec npx tsx "$@"
