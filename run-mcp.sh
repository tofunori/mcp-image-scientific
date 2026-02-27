#!/bin/bash
set -euo pipefail
cd /volume1/Services/mcp/image
export GEMINI_API_KEY="${GEMINI_API_KEY:?Missing GEMINI_API_KEY environment variable}"
exec node dist/index.js
