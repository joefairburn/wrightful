ALTER TABLE `teams` ADD `retentionArtifactDays` integer;--> statement-breakpoint
ALTER TABLE `teams` ADD `retentionTestResultsDays` integer;--> statement-breakpoint
CREATE INDEX `artifacts_project_createdAt_idx` ON `artifacts` (`projectId`,`createdAt`);