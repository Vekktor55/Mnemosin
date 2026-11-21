DROP TABLE `actions`;--> statement-breakpoint
DROP TABLE `ai_decisions`;--> statement-breakpoint
DROP TABLE `turns`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` text,
	`session_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_journal_entries`("id", "turn_id", "session_id", "trace_id", "kind", "payload_json", "created_at") SELECT "id", "turn_id", "session_id", "trace_id", "kind", "payload_json", "created_at" FROM `journal_entries`;--> statement-breakpoint
DROP TABLE `journal_entries`;--> statement-breakpoint
ALTER TABLE `__new_journal_entries` RENAME TO `journal_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_journal_turn` ON `journal_entries` (`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_session` ON `journal_entries` (`session_id`,`id`);