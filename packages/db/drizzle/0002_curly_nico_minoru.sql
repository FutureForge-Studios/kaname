CREATE TABLE "setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"used_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"server_id" uuid,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"breaking" boolean DEFAULT false NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"error" text,
	"rolled_back" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"job_id" uuid,
	"started_by" uuid,
	"started_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "update_runs" ADD CONSTRAINT "update_runs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_runs" ADD CONSTRAINT "update_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_runs" ADD CONSTRAINT "update_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "setup_tokens_hash_key" ON "setup_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "update_runs_kind_idx" ON "update_runs" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "update_runs_server_idx" ON "update_runs" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "update_runs_status_idx" ON "update_runs" USING btree ("status");