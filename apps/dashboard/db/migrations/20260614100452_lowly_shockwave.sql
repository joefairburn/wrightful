ALTER TABLE `teams` ADD `ssoDomain` text;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_ssoDomain_idx` ON `teams` (`ssoDomain`);