#!/bin/sh

export AP_CONTAINER_TYPE="${AP_CONTAINER_TYPE:-WORKER_AND_APP}"
export AP_PORT="${AP_PORT:-80}"

echo "AP_CONTAINER_TYPE: $AP_CONTAINER_TYPE"
echo "AP_PORT: $AP_PORT"

# Auto-generate worker token if not set and JWT secret is available
if [ -z "$AP_WORKER_TOKEN" ] && [ -n "$AP_JWT_SECRET" ]; then
    echo "Auto-generating AP_WORKER_TOKEN..."
    export AP_WORKER_TOKEN=$(node -e "
        const jwt = require('jsonwebtoken');
        const crypto = require('crypto');
        const token = jwt.sign(
            { id: crypto.randomUUID(), type: 'WORKER' },
            process.env.AP_JWT_SECRET,
            { expiresIn: '100y', keyid: '1', algorithm: 'HS256', issuer: 'activepieces' }
        );
        process.stdout.write(token);
    ")
fi

# Build PM2 ecosystem config
# There is no standalone worker package in this repository (the historical
# packages/server/worker was removed upstream): the unified image runs the API
# bootstrap for every AP_CONTAINER_TYPE, and the process decides app/worker
# behavior internally (packages/server/api/src/app/server.ts gates modules on
# system.isApp()/isWorker()). WORKER_AND_APP keeps both roles in ONE process —
# two processes would both listen on ${AP_PORT} and crash with EADDRINUSE — so
# exactly one PM2 app is started, inheriting the exported AP_CONTAINER_TYPE.
APPS="{
    name: 'inboxfm-connect',
    script: 'packages/server/api/dist/src/bootstrap.js',
    node_args: '--enable-source-maps',
    instances: 1,
    exec_mode: 'fork'
}"

cat > /tmp/ecosystem.config.js << ENDOFFILE
module.exports = {
    apps: [${APPS}
    ]
};
ENDOFFILE

echo "Starting Inboxfm Connect with PM2 (${AP_CONTAINER_TYPE} mode)"
pm2-runtime start /tmp/ecosystem.config.js
