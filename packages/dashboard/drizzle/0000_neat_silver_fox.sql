CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`test_result_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`test_result_id`) REFERENCES `test_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_test_result_id_idx` ON `artifacts` (`test_result_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text,
	`ci_provider` text,
	`ci_build_id` text,
	`branch` text,
	`commit_sha` text,
	`commit_message` text,
	`pr_number` integer,
	`repo` text,
	`shard_index` integer,
	`shard_total` integer,
	`total_tests` integer NOT NULL,
	`passed` integer NOT NULL,
	`failed` integer NOT NULL,
	`flaky` integer NOT NULL,
	`skipped` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`reporter_version` text,
	`playwright_version` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_idempotency_key_idx` ON `runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `runs_ci_build_id_idx` ON `runs` (`ci_build_id`);--> statement-breakpoint
CREATE INDEX `runs_branch_created_at_idx` ON `runs` (`branch`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_repo_created_at_idx` ON `runs` (`repo`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`test_result_id` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	FOREIGN KEY (`test_result_id`) REFERENCES `test_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_annotations_test_result_id_idx` ON `test_annotations` (`test_result_id`);--> statement-breakpoint
CREATE TABLE `test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`test_id` text NOT NULL,
	`title` text NOT NULL,
	`file` text NOT NULL,
	`project_name` text,
	`status` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`error_stack` text,
	`worker_index` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_results_test_id_created_at_idx` ON `test_results` (`test_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `test_results_run_id_idx` ON `test_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `test_results_status_created_at_idx` ON `test_results` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`test_result_id` text NOT NULL,
	`tag` text NOT NULL,
	FOREIGN KEY (`test_result_id`) REFERENCES `test_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_tags_tag_idx` ON `test_tags` (`tag`);--> statement-breakpoint
CREATE INDEX `test_tags_test_result_id_idx` ON `test_tags` (`test_result_id`);