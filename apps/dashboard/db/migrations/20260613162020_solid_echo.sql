CREATE TABLE `usageCounters` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`periodStart` integer NOT NULL,
	`runsCount` integer DEFAULT 0 NOT NULL,
	`testResultsCount` integer DEFAULT 0 NOT NULL,
	`artifactBytes` integer DEFAULT 0 NOT NULL,
	`artifactCount` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usageCounters_team_period_idx` ON `usageCounters` (`teamId`,`periodStart`);--> statement-breakpoint
ALTER TABLE `teams` ADD `tier` text DEFAULT 'free' NOT NULL;