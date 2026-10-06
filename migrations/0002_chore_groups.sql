CREATE TABLE `chore_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chore_groups_family` ON `chore_groups` (`family_id`);--> statement-breakpoint
ALTER TABLE `chores` ADD `group_id` text REFERENCES chore_groups(id) ON DELETE SET NULL;--> statement-breakpoint
-- すでにある Family にも、最初のグループを入れる（手で足した）
INSERT INTO `chore_groups` (`id`, `family_id`, `name`, `sort_order`) SELECT lower(hex(randomblob(16))), `id`, 'キッチン', 0 FROM `families`;
--> statement-breakpoint
INSERT INTO `chore_groups` (`id`, `family_id`, `name`, `sort_order`) SELECT lower(hex(randomblob(16))), `id`, '風呂', 1 FROM `families`;
--> statement-breakpoint
INSERT INTO `chore_groups` (`id`, `family_id`, `name`, `sort_order`) SELECT lower(hex(randomblob(16))), `id`, 'トイレ', 2 FROM `families`;
--> statement-breakpoint
INSERT INTO `chore_groups` (`id`, `family_id`, `name`, `sort_order`) SELECT lower(hex(randomblob(16))), `id`, '洗濯', 3 FROM `families`;
--> statement-breakpoint
INSERT INTO `chore_groups` (`id`, `family_id`, `name`, `sort_order`) SELECT lower(hex(randomblob(16))), `id`, 'ゴミ捨て', 4 FROM `families`;
--> statement-breakpoint
INSERT INTO `chore_groups` (`id`, `family_id`, `name`, `sort_order`) SELECT lower(hex(randomblob(16))), `id`, '掃除', 5 FROM `families`;
