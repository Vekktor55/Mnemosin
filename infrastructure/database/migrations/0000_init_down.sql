-- Откат 0000_init.sql (промпт 1.4). Порядок обратный зависимостям FK: сначала дети.
-- ВНИМАНИЕ: откат удаляет данные. В Stage 3 вместо down-миграций — бэкап + forward-fix.
DROP TABLE IF EXISTS `actions`;
DROP TABLE IF EXISTS `ai_decisions`;
DROP TABLE IF EXISTS `chat_messages`;
DROP TABLE IF EXISTS `event_outbox`;
DROP TABLE IF EXISTS `gm_audit_log`;
DROP TABLE IF EXISTS `gm_notes`;
DROP TABLE IF EXISTS `journal_entries`;
DROP TABLE IF EXISTS `snapshots`;
DROP TABLE IF EXISTS `state_history`;
DROP TABLE IF EXISTS `idempotency_records`;
DROP TABLE IF EXISTS `locations`;
DROP TABLE IF EXISTS `world_state_version`;
DROP TABLE IF EXISTS `game_state`;
DROP TABLE IF EXISTS `characters`;
DROP TABLE IF EXISTS `players`;
DROP TABLE IF EXISTS `turns`;
DROP TABLE IF EXISTS `sessions`;
