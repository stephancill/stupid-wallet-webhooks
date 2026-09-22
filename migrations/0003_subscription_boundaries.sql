-- Existing subscriptions did not always receive a boundary. Preserve forward
-- scanning from the last persisted checkpoint; do not enable historical fanout.
UPDATE subscriptions
SET active_from_block = (SELECT cursor_block + 1 FROM chain_registry WHERE chain_id = subscriptions.chain_id)
WHERE status = 'active' AND deleted_at IS NULL AND active_from_block IS NULL
  AND EXISTS (SELECT 1 FROM chain_registry WHERE chain_id = subscriptions.chain_id AND cursor_block IS NOT NULL);

-- Chains without a checkpoint must establish a real RPC head before activation.
INSERT OR IGNORE INTO scanner_operations
  (id, chain_id, kind, address, subscription_id, payload, status, created_at, updated_at)
SELECT 'cmd_boundary_' || id, chain_id, 'subscribe', address, id,
  json_object('chainId', chain_id, 'subscriptionId', id), 'pending',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM subscriptions
WHERE status = 'active' AND deleted_at IS NULL AND active_from_block IS NULL;

UPDATE subscriptions SET status = 'pending'
WHERE status = 'active' AND deleted_at IS NULL AND active_from_block IS NULL;

-- Enforce these invariants even when API creation races webhook deletion.
CREATE TRIGGER subscriptions_require_active_webhook
BEFORE INSERT ON subscriptions
WHEN NOT EXISTS (SELECT 1 FROM webhooks WHERE id = NEW.webhook_id AND account_id = NEW.account_id AND status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'subscription requires an active webhook');
END;

CREATE TRIGGER subscriptions_require_activation_boundary
BEFORE UPDATE OF status, active_from_block ON subscriptions
WHEN NEW.status = 'active' AND NEW.active_from_block IS NULL
BEGIN
  SELECT RAISE(ABORT, 'active subscription requires an activation boundary');
END;

CREATE TRIGGER subscriptions_require_initial_boundary
BEFORE INSERT ON subscriptions
WHEN NEW.status = 'active' AND NEW.active_from_block IS NULL
BEGIN
  SELECT RAISE(ABORT, 'active subscription requires an activation boundary');
END;
