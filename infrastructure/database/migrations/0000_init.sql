CREATE TABLE `actions` (
	`action_id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`player_id` text NOT NULL,
	`sequence_id` integer NOT NULL,
	`intent` text,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`turn_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`player_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_actions_idempotency` ON `actions` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_actions_turn_sequence` ON `actions` (`turn_id`,`sequence_id`);--> statement-breakpoint
CREATE INDEX `idx_actions_player` ON `actions` (`player_id`);--> statement-breakpoint
CREATE TABLE `ai_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`prompt_hash` text,
	`response_json` text,
	`violations_count` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`trace_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_decisions_turn` ON `ai_decisions` (`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_decisions_session` ON `ai_decisions` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `characters` (
	`character_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`archetype` text,
	`created_at` text NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_characters_session` ON `characters` (`session_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`visibility` text NOT NULL,
	`from_player_id` text,
	`to_player_id` text,
	`created_at` text NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_session_created` ON `chat_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_chat_visibility` ON `chat_messages` (`session_id`,`visibility`);--> statement-breakpoint
CREATE TABLE `event_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_name` text NOT NULL,
	`payload_json` text NOT NULL,
	`trace_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`emitted_at` text NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_outbox_status` ON `event_outbox` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_event` ON `event_outbox` (`event_name`);--> statement-breakpoint
CREATE TABLE `game_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`current_location_id` text NOT NULL,
	`time_of_day` text NOT NULL,
	`ending_reached` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gm_audit_log` (
	`audit_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`gm_player_id` text NOT NULL,
	`action` text NOT NULL,
	`trace_id` text NOT NULL,
	`idempotency_key` text,
	`at` text NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_gm_audit_session` ON `gm_audit_log` (`session_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_gm_audit_action` ON `gm_audit_log` (`action`);--> statement-breakpoint
CREATE TABLE `gm_notes` (
	`note_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`visibility` text NOT NULL,
	`created_at` text NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_gm_notes_session` ON `gm_notes` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`key` text PRIMARY KEY NOT NULL,
	`turn_id` text,
	`session_id` text,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`result_hash` text NOT NULL,
	`error_code` text,
	`trace_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_expires` ON `idempotency_records` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_idempotency_session` ON `idempotency_records` (`session_id`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_journal_turn` ON `journal_entries` (`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_session` ON `journal_entries` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `locations` (
	`location_id` text PRIMARY KEY NOT NULL,
	`pack_id` text,
	`template_slug` text,
	`name` text NOT NULL,
	`exits_count` integer DEFAULT 0 NOT NULL,
	`objects_count` integer DEFAULT 0 NOT NULL,
	`has_gm_secret` integer DEFAULT false NOT NULL,
	`updated_at` text,
	`body_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_locations_pack` ON `locations` (`pack_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`player_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`character_id` text NOT NULL,
	`display_name` text NOT NULL,
	`is_gm` integer NOT NULL,
	`status` text NOT NULL,
	`joined_at` text NOT NULL,
	`left_at` text,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_players_session` ON `players` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_players_session_character` ON `players` (`session_id`,`character_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`gm_player_id` text NOT NULL,
	`current_turn_id` text,
	`world_pack_id` text,
	`world_pack_version` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`body_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_status` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sessions_updated` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`label` text NOT NULL,
	`turn_number` integer NOT NULL,
	`created_by_turn_id` text,
	`created_by` text NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text NOT NULL,
	`state_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_session` ON `snapshots` (`session_id`,`turn_number`);--> statement-breakpoint
CREATE TABLE `state_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`from_version` integer NOT NULL,
	`to_version` integer NOT NULL,
	`mutations_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_state_history_session` ON `state_history` (`session_id`,`to_version`);--> statement-breakpoint
CREATE TABLE `turns` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`number` integer NOT NULL,
	`status` text NOT NULL,
	`locked_at` text,
	`processing_started_at` text,
	`review_ready_at` text,
	`committed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`body_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_turns_session_number` ON `turns` (`session_id`,`number`);--> statement-breakpoint
CREATE INDEX `idx_turns_session_status` ON `turns` (`session_id`,`status`);--> statement-breakpoint
CREATE TABLE `world_state_version` (
	`session_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
