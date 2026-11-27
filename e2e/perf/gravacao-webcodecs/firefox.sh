#!/bin/bash
# runs ff.html (or $1) in headless Waterfox with a throwaway profile and waits for "done"
S=$(dirname "$(readlink -f "$0")")
cd "$S"
PAGE=${1:-ff.html}
rm -f server.log
node server.mjs > server.log 2>&1 &
SRV=$!
sleep 0.5
rm -rf ffprofile-run && cp -r ffprofile ffprofile-run
${WATERFOX:-/opt/waterfox/waterfox} $WFFLAGS --no-remote --profile "$S/ffprofile-run" "http://127.0.0.1:9411/$PAGE" > wf.log 2>&1 &
WF=$!
for i in $(seq 1 ${WAIT:-60}); do grep -q '"done"\|"error"' server.log 2>/dev/null && break; sleep 1; done
kill $WF 2>/dev/null; sleep 1; kill -9 $WF 2>/dev/null
kill $SRV 2>/dev/null
cat server.log
