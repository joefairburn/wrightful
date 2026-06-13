CREATE TABLE `githubInstallations` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`installationId` integer NOT NULL,
	`accountLogin` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `githubInstallations_installationId_idx` ON `githubInstallations` (`installationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `githubInstallations_accountLogin_idx` ON `githubInstallations` (`accountLogin`);--> statement-breakpoint
CREATE INDEX `githubInstallations_team_idx` ON `githubInstallations` (`teamId`);--> statement-breakpoint
ALTER TABLE `runs` ADD `githubCheckRunId` integer;