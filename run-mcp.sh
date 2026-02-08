#!/bin/bash
set -euo pipefail
cd /volume1/Services/mcp/image
exec node dist/index.js
