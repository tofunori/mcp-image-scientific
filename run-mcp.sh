#!/bin/bash
set -euo pipefail
cd /volume1/Services/mcp/image
export GEMINI_API_KEY='AIzaSyD5op3_1c0aMUMxYuTmVNyzsz2-b0aP2wk'
exec node dist/index.js
