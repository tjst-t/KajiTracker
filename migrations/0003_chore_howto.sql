ALTER TABLE `chores` ADD `howto` text;--> statement-breakpoint
ALTER TABLE `chores` ADD `howto_updated_at` text;--> statement-breakpoint
ALTER TABLE `chores` ADD `howto_updated_by` text REFERENCES users(id) ON DELETE set null;