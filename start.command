#!/bin/sh
# Double-click to serve the reader at http://localhost:8510 and open it.
# Needed for Google sign-in, which has to return to a web address; everything
# else also works by opening index.html directly.
cd "$(dirname "$0")" || exit 1
echo ""
echo "  Max's Speed Reader is running at http://localhost:8510"
echo "  Keep this window open while you read. Closing it stops the reader,"
echo "  and signing in with Google needs it running to come back to."
echo ""
( sleep 1; open "http://localhost:8510/" ) &
exec python3 -m http.server 8510 2>/dev/null
