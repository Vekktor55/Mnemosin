-- Откат 0001: пересоздаёт legacy-таблицы Turn Engine без восстановления удалённых данных.
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
CREATE INDEX `idx_ai_decisions_session` ON `ai_decisions` (`session_id`,`id`);
