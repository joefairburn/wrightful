DROP INDEX `testResultAttempts_testResultId_idx`;--> statement-breakpoint
DROP INDEX `testResults_runId_idx`;--> statement-breakpoint
DROP INDEX `testResults_status_createdAt_idx`;--> statement-breakpoint
CREATE INDEX `testResults_project_testId_createdAt_idx` ON `testResults` (`projectId`,`testId`,`createdAt`);--> statement-breakpoint
DROP INDEX `testTags_tag_idx`;--> statement-breakpoint
CREATE INDEX `runs_running_idx` ON `runs` (`createdAt`) WHERE "runs"."status" = 'running';