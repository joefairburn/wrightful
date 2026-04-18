CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `api_keys_project_idx` ON `api_keys` (`project_id`);--> statement-breakpoint
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
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_team_idx` ON `memberships` (`user_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `memberships_team_idx` ON `memberships` (`team_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_team_slug_idx` ON `projects` (`team_id`,`slug`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`idempotency_key` text,
	`ci_provider` text,
	`ci_build_id` text,
	`branch` text,
	`environment` text,
	`commit_sha` text,
	`commit_message` text,
	`pr_number` integer,
	`repo` text,
	`actor` text,
	`total_tests` integer NOT NULL,
	`passed` integer NOT NULL,
	`failed` integer NOT NULL,
	`flaky` integer NOT NULL,
	`skipped` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`reporter_version` text,
	`playwright_version` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_project_idempotency_key_idx` ON `runs` (`project_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `runs_ci_build_id_idx` ON `runs` (`ci_build_id`);--> statement-breakpoint
CREATE INDEX `runs_branch_created_at_idx` ON `runs` (`branch`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_environment_created_at_idx` ON `runs` (`environment`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_project_created_at_idx` ON `runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_idx` ON `teams` (`slug`);--> statement-breakpoint
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
CREATE INDEX `test_tags_test_result_id_idx` ON `test_tags` (`test_result_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);