#!/bin/bash
cd "$(dirname "$0")/.."
export $(grep -v '^#' .env.staging | xargs)
node src/server.mjs
