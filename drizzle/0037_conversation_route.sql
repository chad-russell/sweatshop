ALTER TABLE `conversations` ADD `route` text;--> statement-breakpoint
UPDATE `conversations` SET `route` = json_object('provider', 'glm', 'model', `model_id`) WHERE `model_id` IS NOT NULL;
