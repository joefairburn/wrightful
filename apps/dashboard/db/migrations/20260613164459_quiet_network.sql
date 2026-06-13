CREATE TABLE `runShares` (
	`id` text PRIMARY KEY NOT NULL,
	`runId` text NOT NULL,
	`projectId` text NOT NULL,
	`teamId` text NOT NULL,
	`tokenHash` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`revokedAt` integer,
	FOREIGN KEY (`runId`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runShares_tokenHash_idx` ON `runShares` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `runShares_run_idx` ON `runShares` (`runId`);