ALTER TABLE `sandboxes` RENAME COLUMN `services_provisioned_at` TO `migrated_at`;--> statement-breakpoint
UPDATE `preview_setups` SET `definition` = json_remove(json_set(`definition`, '$.migrate', json_extract(`definition`, '$.provision')), '$.provision') WHERE json_type(`definition`, '$.provision') IS NOT NULL;--> statement-breakpoint
UPDATE `previews` SET `env` = NULL WHERE `env` IS NOT NULL;
