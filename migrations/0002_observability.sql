-- Milestone 4/5: observability. Track the observed chain head so lag
-- (head - cursor) and lag-based alerts can be computed.
ALTER TABLE chain_registry ADD COLUMN last_head_block INTEGER;