CREATE TABLE "account_limits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"server_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"max_sites" integer,
	"max_domains" integer,
	"max_mailboxes" integer,
	"max_databases" integer,
	"max_disk_mb" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reseller_branding" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"logo_text" text,
	"support_email" text,
	"support_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_owners" (
	"kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_owners_kind_resource_id_pk" PRIMARY KEY("kind","resource_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "view_mode" text DEFAULT 'advanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "audience" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "account_limits" ADD CONSTRAINT "account_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_branding" ADD CONSTRAINT "reseller_branding_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_owners" ADD CONSTRAINT "resource_owners_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_owners" ADD CONSTRAINT "resource_owners_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_owners_owner_idx" ON "resource_owners" USING btree ("owner_id","kind");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_parent_id_users_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_parent_idx" ON "users" USING btree ("parent_id");