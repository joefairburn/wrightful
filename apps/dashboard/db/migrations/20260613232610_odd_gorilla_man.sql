CREATE TABLE `testOwners` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`testId` text NOT NULL,
	`owner` text NOT NULL,
	`source` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `testOwners_project_testId_owner_idx` ON `testOwners` (`projectId`,`testId`,`owner`);--> statement-breakpoint
CREATE INDEX `testOwners_project_testId_idx` ON `testOwners` (`projectId`,`testId`);--> statement-breakpoint
ALTER TABLE `projects` ADD `codeownersFile` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `codeownersUpdatedAt` integer;