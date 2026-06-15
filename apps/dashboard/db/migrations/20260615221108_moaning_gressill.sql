CREATE TABLE `auditLog` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`projectId` text,
	`actorUserId` text NOT NULL,
	`action` text NOT NULL,
	`targetType` text,
	`targetId` text,
	`metadata` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `auditLog_team_createdAt_idx` ON `auditLog` (`teamId`,`createdAt`);--> statement-breakpoint
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
CREATE TABLE `memberGroupMembers` (
	`groupId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`groupId`, `userId`),
	FOREIGN KEY (`groupId`) REFERENCES `memberGroups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memberGroups` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`name` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberGroups_team_name_idx` ON `memberGroups` (`teamId`,`name`);--> statement-breakpoint
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
CREATE INDEX `quarantinedTests_project_createdAt_idx` ON `quarantinedTests` (`projectId`,`createdAt`);--> statement-breakpoint
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
ALTER TABLE `monitors` ADD `alertsEnabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `alertTargets` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `codeownersFile` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `codeownersUpdatedAt` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `githubCheckRunId` integer;--> statement-breakpoint
ALTER TABLE `teams` ADD `tier` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `retentionArtifactDays` integer;--> statement-breakpoint
ALTER TABLE `teams` ADD `retentionTestResultsDays` integer;--> statement-breakpoint
CREATE INDEX `artifacts_project_createdAt_idx` ON `artifacts` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `testTags_project_tag_idx` ON `testTags` (`projectId`,`tag`);