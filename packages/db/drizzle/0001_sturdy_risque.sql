ALTER TABLE "servers" ADD COLUMN "cert_pem" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "primary_domain_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "restore_point_id" uuid;