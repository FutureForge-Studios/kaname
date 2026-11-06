CREATE TABLE "mail_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"status" text DEFAULT 'not_installed' NOT NULL,
	"version" text,
	"install_complete" boolean DEFAULT false NOT NULL,
	"hostname" text,
	"primary_domain" text,
	"admin_email" text,
	"sending_mode" text,
	"relay_provider" text,
	"console_url" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"certificate" jsonb,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_auth_checks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail_forwarders" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail_log_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mail_auth_checks" CASCADE;--> statement-breakpoint
DROP TABLE "mail_forwarders" CASCADE;--> statement-breakpoint
DROP TABLE "mail_log_entries" CASCADE;--> statement-breakpoint
-- Destructive on purpose: the rows below described a Postfix/Dovecot stack
-- Kaname no longer drives. A Yunori Mail Server is authoritative for its
-- domains, mailboxes and aliases, and the first sync re-reads them from the
-- host, so nothing here can be carried over and the new NOT NULL columns
-- have no honest value for an old row.
DELETE FROM "mail_aliases";--> statement-breakpoint
DELETE FROM "mailboxes";--> statement-breakpoint
DELETE FROM "mail_domains";--> statement-breakpoint
UPDATE "domains" SET "has_mail" = false;--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD COLUMN "server_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD COLUMN "mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD COLUMN "mailbox_address" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "mail_server_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "dns_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "dns_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "zone_file" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_servers_server_key" ON "mail_servers" USING btree ("server_id");--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD CONSTRAINT "mail_aliases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD CONSTRAINT "mail_aliases_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_mail_server_id_mail_servers_id_fk" FOREIGN KEY ("mail_server_id") REFERENCES "public"."mail_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_aliases_domain_idx" ON "mail_aliases" USING btree ("mail_domain_id");--> statement-breakpoint
CREATE INDEX "mail_domains_mail_server_idx" ON "mail_domains" USING btree ("mail_server_id");--> statement-breakpoint
ALTER TABLE "mail_aliases" DROP COLUMN "destinations";--> statement-breakpoint
ALTER TABLE "mail_aliases" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "mail_aliases" DROP COLUMN "comment";--> statement-breakpoint
ALTER TABLE "mail_domains" DROP COLUMN "mail_hostname";--> statement-breakpoint
ALTER TABLE "mail_domains" DROP COLUMN "dkim_selector";--> statement-breakpoint
ALTER TABLE "mail_domains" DROP COLUMN "dkim_public_key";--> statement-breakpoint
ALTER TABLE "mail_domains" DROP COLUMN "catchall_target";--> statement-breakpoint
ALTER TABLE "mail_domains" DROP COLUMN "quota_total";--> statement-breakpoint
ALTER TABLE "mail_domains" DROP COLUMN "last_auth_check_at";--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "used_bytes";--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "message_count";--> statement-breakpoint
ALTER TABLE "mailboxes" DROP COLUMN "last_login_at";