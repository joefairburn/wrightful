CREATE TABLE `quarantinedTests` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`testId` text NOT NULL,
	`reason` text,
	`mode` text DEFAULT 'skip' NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quarantinedTests_project_testId_idx` ON `quarantinedTests` (`projectId`,`testId`);--> statement-breakpoint
CREATE INDEX `quarantinedTests_project_createdAt_idx` ON `quarantinedTests` (`projectId`,`createdAt`);