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
CREATE INDEX `auditLog_team_createdAt_idx` ON `auditLog` (`teamId`,`createdAt`);