CREATE TABLE "app_monitors" (
	"app_install_id" uuid PRIMARY KEY NOT NULL,
	"probe_path" text DEFAULT '/' NOT NULL,
	"probe_enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status_code" integer,
	"last_latency_ms" integer,
	"last_error" text,
	"containers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"containers_sampled_at" timestamp with time zone,
	"data_bytes" bigint,
	"data_measured_at" timestamp with time zone,
	"defaults_seeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_health_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_install_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean,
	"status_code" integer,
	"latency_ms" integer,
	"error" text,
	"containers_total" integer,
	"containers_running" integer,
	"containers_unhealthy" integer,
	"restart_count" integer,
	"cpu_percent" real,
	"memory_bytes" bigint,
	"memory_limit" bigint
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "app_install_id" uuid;--> statement-breakpoint
ALTER TABLE "app_monitors" ADD CONSTRAINT "app_monitors_app_install_id_app_installs_id_fk" FOREIGN KEY ("app_install_id") REFERENCES "public"."app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_health_samples" ADD CONSTRAINT "app_health_samples_app_install_id_app_installs_id_fk" FOREIGN KEY ("app_install_id") REFERENCES "public"."app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_app_install_id_app_installs_id_fk" FOREIGN KEY ("app_install_id") REFERENCES "public"."app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_health_samples_install_ts_idx" ON "app_health_samples" USING btree ("app_install_id","kind","ts");--> statement-breakpoint
CREATE INDEX "alert_rules_app_install_idx" ON "alert_rules" USING btree ("app_install_id");
