CREATE TABLE `shopping_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`section_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`added_by` text,
	`cart_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `shopping_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `shopping_sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cart_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shopping_items_list` ON `shopping_items` (`list_id`);--> statement-breakpoint
CREATE TABLE `shopping_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shopping_lists_family` ON `shopping_lists` (`family_id`);--> statement-breakpoint
CREATE TABLE `shopping_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`section_id` text,
	`section_name` text,
	`user_id` text,
	`bought_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `shopping_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `shopping_sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shopping_purchases_list_name` ON `shopping_purchases` (`list_id`,`name`);--> statement-breakpoint
CREATE INDEX `shopping_purchases_family` ON `shopping_purchases` (`family_id`,`bought_at`);--> statement-breakpoint
CREATE TABLE `shopping_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `shopping_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shopping_sections_list` ON `shopping_sections` (`list_id`);--> statement-breakpoint
-- すでにある Family にも、最初のリスト（スーパー・コストコ・IKEA）と、それぞれに最初の売り場を入れる（手で足した）
INSERT INTO `shopping_lists` (`id`, `family_id`, `name`, `sort_order`)
SELECT lower(hex(randomblob(16))), f.`id`, d.value, d.key FROM `families` f
CROSS JOIN json_each('["スーパー","コストコ","IKEA"]') d;
--> statement-breakpoint
INSERT INTO `shopping_sections` (`id`, `list_id`, `name`, `sort_order`)
SELECT lower(hex(randomblob(16))), l.`id`, d.value, d.key FROM `shopping_lists` l
CROSS JOIN json_each('["野菜・果物","肉・魚","乳製品・卵","パン・主食","調味料・乾物","飲み物","お菓子","冷凍食品","日用品","その他"]') d;
