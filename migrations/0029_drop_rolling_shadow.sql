-- Daytime Dream is a single on/off switch now, on by default. The read-only "shadow" comparison
-- mode is gone, together with its separate progress columns, its draft events and its navigation
-- state. A saved ROLLING_DREAM=shadow becomes "false": shadow never wrote anything, so it must not
-- turn into daytime writes just because the new default is on.
DELETE FROM memory_events WHERE event_type='rolling_shadow';
DELETE FROM processing_cursors WHERE name GLOB 'rolling_shadow_state:*';
UPDATE gateway_config SET config_json=json_set(config_json,'$.settings.ROLLING_DREAM','false')
  WHERE json_valid(config_json) AND json_extract(config_json,'$.settings.ROLLING_DREAM')='shadow';

DROP INDEX idx_rolling_inbox_shadow_open;
DROP INDEX idx_rolling_inbox_shadow_claim;
ALTER TABLE rolling_inbox DROP COLUMN shadow_window_key;
ALTER TABLE rolling_inbox DROP COLUMN shadow_claimed_at;
ALTER TABLE rolling_inbox DROP COLUMN shadow_attempts;
ALTER TABLE rolling_inbox DROP COLUMN shadow_progress;
ALTER TABLE rolling_inbox DROP COLUMN shadow_done_at;
ALTER TABLE rolling_inbox DROP COLUMN shadow_error;
