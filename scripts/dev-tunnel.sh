#!/usr/bin/env bash
# Expose the local agent service (:8787) for webhooks (Twilio, Gmail Pub/Sub push).
# Requires cloudflared: brew install cloudflared
#
# Paste the printed https URL into:
#   - Twilio Console → your number → Messaging webhook:  <url>/webhooks/twilio/sms
#   - A dev Pub/Sub push subscription endpoint:          <url>/webhooks/gmail/pubsub
set -euo pipefail

PORT="${AGENT_PORT:-8787}"
echo "Tunneling http://localhost:${PORT} ..."
exec cloudflared tunnel --url "http://localhost:${PORT}"
