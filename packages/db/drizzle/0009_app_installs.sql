CREATE TABLE "app_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"app_name" text NOT NULL,
	"app_version" text NOT NULL,
	"server_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"ssl" boolean DEFAULT true NOT NULL,
	"db_engine" text,
	"inputs" jsonb NOT NULL,
	"site_id" uuid,
	"domain_id" uuid,
	"database_id" uuid,
	"db_user_id" uuid,
	"certificate_id" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"job_id" uuid,
	"created_by" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_database_id_db_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."db_databases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_db_user_id_db_users_id_fk" FOREIGN KEY ("db_user_id") REFERENCES "public"."db_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_installs_server_idx" ON "app_installs" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "app_installs_domain_idx" ON "app_installs" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "app_installs_created_by_idx" ON "app_installs" USING btree ("created_by");
