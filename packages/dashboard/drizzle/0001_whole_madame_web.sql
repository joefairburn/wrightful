ALTER TABLE `runs` ADD `environment` text;--> statement-breakpoint
CREATE INDEX `runs_environment_created_at_idx` ON `runs` (`environment`,`created_at`);