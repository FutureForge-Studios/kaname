CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_kind" text DEFAULT 'global' NOT NULL,
	"scope_server_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" "inet",
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_label" text DEFAULT '' NOT NULL,
	"server_id" uuid,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"diff" jsonb,
	"job_id" uuid,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"scope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"mfa_satisfied_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"recovery_codes_enc" text,
	"status" text DEFAULT 'invited' NOT NULL,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_login_ip" "inet",
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"duration_seconds" integer DEFAULT 300 NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"scope" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channels" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"server_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"severity" text NOT NULL,
	"value" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"message" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"container_id" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"image_id" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"runtime" text DEFAULT 'docker' NOT NULL,
	"ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"networks" text[] DEFAULT '{}'::text[] NOT NULL,
	"mounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"cpu_percent" real,
	"memory_usage" bigint,
	"memory_limit" bigint,
	"created_at_host" timestamp with time zone,
	"started_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_percent" real NOT NULL,
	"memory_used" bigint NOT NULL,
	"memory_total" bigint NOT NULL,
	"swap_used" bigint DEFAULT 0 NOT NULL,
	"swap_total" bigint DEFAULT 0 NOT NULL,
	"load1" real DEFAULT 0 NOT NULL,
	"load5" real DEFAULT 0 NOT NULL,
	"load15" real DEFAULT 0 NOT NULL,
	"processes" integer DEFAULT 0 NOT NULL,
	"net_rx_rate" double precision DEFAULT 0 NOT NULL,
	"net_tx_rate" double precision DEFAULT 0 NOT NULL,
	"net_rx_bytes" bigint DEFAULT 0 NOT NULL,
	"net_tx_bytes" bigint DEFAULT 0 NOT NULL,
	"disk_read_rate" double precision,
	"disk_write_rate" double precision,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_metrics_5m" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 1 NOT NULL,
	"cpu_percent" real NOT NULL,
	"memory_used" bigint NOT NULL,
	"memory_total" bigint NOT NULL,
	"swap_used" bigint DEFAULT 0 NOT NULL,
	"swap_total" bigint DEFAULT 0 NOT NULL,
	"load1" real DEFAULT 0 NOT NULL,
	"load5" real DEFAULT 0 NOT NULL,
	"load15" real DEFAULT 0 NOT NULL,
	"processes" integer DEFAULT 0 NOT NULL,
	"net_rx_rate" double precision DEFAULT 0 NOT NULL,
	"net_tx_rate" double precision DEFAULT 0 NOT NULL,
	"net_rx_bytes" bigint DEFAULT 0 NOT NULL,
	"net_tx_bytes" bigint DEFAULT 0 NOT NULL,
	"disk_read_rate" double precision,
	"disk_write_rate" double precision,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hostname" text NOT NULL,
	"address" text,
	"provider" text,
	"os" text,
	"os_family" text,
	"os_version" text,
	"arch" text,
	"kernel" text,
	"machine_id" text,
	"cpu_model" text,
	"cpu_cores" integer,
	"memory_total" bigint,
	"timezone" text,
	"virtualization" text,
	"agent_version" text,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"connection" text DEFAULT 'never_enrolled' NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"health_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_seen_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone,
	"boot_time" timestamp with time zone,
	"cert_serial" text,
	"cert_fingerprint" text,
	"cert_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"load_state" text DEFAULT 'loaded' NOT NULL,
	"active_state" text DEFAULT 'unknown' NOT NULL,
	"sub_state" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"main_pid" integer,
	"memory_current" bigint,
	"active_since" timestamp with time zone,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_logs" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"server_id" uuid,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"progress" real,
	"blocked_reason" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"correlation_id" uuid,
	"parent_id" uuid,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_owner" text,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_by_name" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"wrapped_key" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_recordings" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"offset_ms" integer NOT NULL,
	"direction" text NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid,
	"user_name" text NOT NULL,
	"posix_user" text DEFAULT 'root' NOT NULL,
	"ticket_hash" text NOT NULL,
	"ip" "inet",
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	"command_count" integer DEFAULT 0 NOT NULL,
	"recorded" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid,
	"server_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"sans" text[] DEFAULT '{}'::text[] NOT NULL,
	"issuer" text DEFAULT 'Let''s Encrypt' NOT NULL,
	"challenge" text DEFAULT 'http-01' NOT NULL,
	"key_type" text DEFAULT 'ecdsa' NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"last_renewal_at" timestamp with time zone,
	"last_renewal_job_id" uuid,
	"last_error" text,
	"installed_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"source" text DEFAULT 'git' NOT NULL,
	"repo_url" text,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"commit_author" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"triggered_by" uuid,
	"triggered_by_name" text,
	"job_id" uuid,
	"release_path" text,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"ttl" integer DEFAULT 300 NOT NULL,
	"priority" integer,
	"proxied" boolean DEFAULT false NOT NULL,
	"managed_by" text DEFAULT 'kaname' NOT NULL,
	"external_id" text,
	"drift" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"site_id" uuid,
	"server_id" uuid,
	"dns_provider" text DEFAULT 'manual' NOT NULL,
	"dns_zone_id" text,
	"proxied" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"registrar" text,
	"expires_at" timestamp with time zone,
	"nameservers" text[] DEFAULT '{}'::text[] NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verification_method" text,
	"verified_at" timestamp with time zone,
	"has_mail" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"webroot" text NOT NULL,
	"runtime" text DEFAULT 'static' NOT NULL,
	"runtime_version" text,
	"upstream" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"force_https" boolean DEFAULT true NOT NULL,
	"config_path" text,
	"owner" text,
	"disk_usage" bigint,
	"last_error" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repo_url" text,
	"branch" text,
	"build_command" text,
	"output_dir" text,
	"deploy_key_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ftp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"username" text NOT NULL,
	"protocol" text DEFAULT 'sftp' NOT NULL,
	"home_dir" text NOT NULL,
	"quota_bytes" bigint DEFAULT 0 NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"secret_ref" text,
	"ssh_key_id" uuid,
	"chroot" text,
	"last_login_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total" bigint NOT NULL,
	"used" bigint NOT NULL,
	"available" bigint NOT NULL,
	"mounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"largest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inodes_total" bigint,
	"inodes_used" bigint,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "mail_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mail_domain_id" uuid NOT NULL,
	"address" text NOT NULL,
	"destinations" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_auth_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mail_domain_id" uuid NOT NULL,
	"check" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"expected" text,
	"actual" text,
	"remediation" jsonb,
	"resolver_used" text,
	"duration_ms" integer,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"mail_hostname" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"dkim_selector" text DEFAULT 'default' NOT NULL,
	"dkim_public_key" text,
	"catchall_target" text,
	"quota_total" bigint DEFAULT 0 NOT NULL,
	"last_auth_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_forwarders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mail_domain_id" uuid NOT NULL,
	"source" text NOT NULL,
	"destination" text NOT NULL,
	"keep_copy" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_log_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"queue_id" text,
	"direction" text NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text,
	"status" text NOT NULL,
	"relay" text,
	"delay_seconds" integer,
	"size_bytes" bigint,
	"dsn" text,
	"message" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mail_domain_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"address" text NOT NULL,
	"local_part" text NOT NULL,
	"display_name" text,
	"quota_bytes" bigint DEFAULT 0 NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"name" text NOT NULL,
	"owner" text,
	"encoding" text DEFAULT 'UTF8' NOT NULL,
	"collation" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"table_count" integer DEFAULT 0 NOT NULL,
	"last_backup_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"db_user_id" uuid NOT NULL,
	"privileges" text[] DEFAULT '{}'::text[] NOT NULL,
	"grant_option" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"host" text DEFAULT '127.0.0.1' NOT NULL,
	"port" integer NOT NULL,
	"status" text DEFAULT 'unreachable' NOT NULL,
	"uptime_seconds" integer,
	"connections" integer,
	"max_connections" integer,
	"data_size" bigint,
	"admin_secret_ref" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"username" text NOT NULL,
	"host_pattern" text DEFAULT 'localhost' NOT NULL,
	"auth_plugin" text,
	"can_login" boolean DEFAULT true NOT NULL,
	"is_superuser" boolean DEFAULT false NOT NULL,
	"secret_ref" text,
	"last_used_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firewall_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"action" text NOT NULL,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"protocol" text DEFAULT 'tcp' NOT NULL,
	"port_spec" text,
	"source_cidr" text,
	"dest_cidr" text,
	"comment" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"managed_by" text DEFAULT 'kaname' NOT NULL,
	"hit_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firewall_state" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"backend" text DEFAULT 'nftables' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"default_inbound" text DEFAULT 'deny' NOT NULL,
	"default_outbound" text DEFAULT 'allow' NOT NULL,
	"last_applied_at" timestamp with time zone,
	"pending_rollback_token" text,
	"pending_rollback_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid,
	"cidr" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_configs" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"permit_root_login" text DEFAULT 'prohibit-password' NOT NULL,
	"password_authentication" boolean DEFAULT false NOT NULL,
	"pubkey_authentication" boolean DEFAULT true NOT NULL,
	"max_auth_tries" integer DEFAULT 4 NOT NULL,
	"allow_users" text[] DEFAULT '{}'::text[] NOT NULL,
	"allow_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"x11_forwarding" boolean DEFAULT false NOT NULL,
	"last_applied_at" timestamp with time zone,
	"pending_rollback_token" text,
	"pending_rollback_until" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"type" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"user_id" uuid,
	"server_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"posix_user" text DEFAULT 'root' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"user" text NOT NULL,
	"from_ip" "inet",
	"tty" text,
	"pid" integer,
	"started_at" timestamp with time zone NOT NULL,
	"idle_seconds" integer DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threat_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_ip" "inet" NOT NULL,
	"source_country" text,
	"source_asn" text,
	"target" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"disposition" text DEFAULT 'observed' NOT NULL,
	"sample" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
	"status" text DEFAULT 'untested' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"snapshot_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid,
	"server_id" uuid NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"job_id" uuid,
	"error" text,
	"triggered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"server_id" uuid NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"destination_id" uuid NOT NULL,
	"retention" jsonb DEFAULT '{"keep_last":7,"keep_daily":7,"keep_weekly":4,"keep_monthly":6}'::jsonb NOT NULL,
	"encryption" boolean DEFAULT true NOT NULL,
	"repository_path" text NOT NULL,
	"password_ref" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"schedule_id" uuid,
	"server_id" uuid NOT NULL,
	"label" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_metrics" ADD CONSTRAINT "server_metrics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_metrics_5m" ADD CONSTRAINT "server_metrics_5m_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_recordings" ADD CONSTRAINT "terminal_recordings_session_id_terminal_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."terminal_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_last_renewal_job_id_jobs_id_fk" FOREIGN KEY ("last_renewal_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ftp_accounts" ADD CONSTRAINT "ftp_accounts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ftp_accounts" ADD CONSTRAINT "ftp_accounts_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_samples" ADD CONSTRAINT "storage_samples_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD CONSTRAINT "mail_aliases_mail_domain_id_mail_domains_id_fk" FOREIGN KEY ("mail_domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_auth_checks" ADD CONSTRAINT "mail_auth_checks_mail_domain_id_mail_domains_id_fk" FOREIGN KEY ("mail_domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_forwarders" ADD CONSTRAINT "mail_forwarders_mail_domain_id_mail_domains_id_fk" FOREIGN KEY ("mail_domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_log_entries" ADD CONSTRAINT "mail_log_entries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_mail_domain_id_mail_domains_id_fk" FOREIGN KEY ("mail_domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_databases" ADD CONSTRAINT "db_databases_instance_id_db_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."db_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_databases" ADD CONSTRAINT "db_databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_grants" ADD CONSTRAINT "db_grants_database_id_db_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."db_databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_grants" ADD CONSTRAINT "db_grants_db_user_id_db_users_id_fk" FOREIGN KEY ("db_user_id") REFERENCES "public"."db_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_instances" ADD CONSTRAINT "db_instances_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_users" ADD CONSTRAINT "db_users_instance_id_db_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."db_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_users" ADD CONSTRAINT "db_users_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_rules" ADD CONSTRAINT "firewall_rules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firewall_state" ADD CONSTRAINT "firewall_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_blocks" ADD CONSTRAINT "ip_blocks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_blocks" ADD CONSTRAINT "ip_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_configs" ADD CONSTRAINT "ssh_configs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_sessions" ADD CONSTRAINT "ssh_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threat_events" ADD CONSTRAINT "threat_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_schedule_id_backup_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."backup_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_destination_id_backup_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_points" ADD CONSTRAINT "restore_points_run_id_backup_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_points" ADD CONSTRAINT "restore_points_schedule_id_backup_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."backup_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_points" ADD CONSTRAINT "restore_points_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_created_by_idx" ON "api_keys" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_events" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_server_idx" ON "audit_events" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_hash_key" ON "audit_events" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "role_grants_role_idx" ON "role_grants" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_grants_unique" ON "role_grants" USING btree ("role_id","permission");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_slug_key" ON "roles" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "alert_rules_metric_idx" ON "alert_rules" USING btree ("metric");--> statement-breakpoint
CREATE INDEX "alerts_state_idx" ON "alerts" USING btree ("state");--> statement-breakpoint
CREATE INDEX "alerts_server_idx" ON "alerts" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_key" ON "alerts" USING btree ("rule_id","server_id") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "containers_server_cid_key" ON "containers" USING btree ("server_id","container_id");--> statement-breakpoint
CREATE INDEX "containers_state_idx" ON "containers" USING btree ("server_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_tokens_hash_key" ON "enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "enrollment_tokens_server_idx" ON "enrollment_tokens" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_metrics_server_ts_idx" ON "server_metrics" USING btree ("server_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "server_metrics_5m_key" ON "server_metrics_5m" USING btree ("server_id","bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_name_key" ON "servers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "servers_connection_idx" ON "servers" USING btree ("connection");--> statement-breakpoint
CREATE INDEX "servers_health_idx" ON "servers" USING btree ("health");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_cert_serial_key" ON "servers" USING btree ("cert_serial");--> statement-breakpoint
CREATE UNIQUE INDEX "services_server_unit_key" ON "services" USING btree ("server_id","unit");--> statement-breakpoint
CREATE INDEX "services_state_idx" ON "services" USING btree ("server_id","active_state");--> statement-breakpoint
CREATE INDEX "job_logs_job_idx" ON "job_logs" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_after","priority") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_server_idx" ON "jobs" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_correlation_idx" ON "jobs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "jobs_parent_idx" ON "jobs" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("lease_until") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_name_key" ON "notification_channels" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_ref_key" ON "secrets" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "secrets_owner_idx" ON "secrets" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "terminal_recordings_session_idx" ON "terminal_recordings" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "terminal_sessions_ticket_key" ON "terminal_sessions" USING btree ("ticket_hash");--> statement-breakpoint
CREATE INDEX "terminal_sessions_server_idx" ON "terminal_sessions" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_server_subject_key" ON "certificates" USING btree ("server_id","subject");--> statement-breakpoint
CREATE INDEX "certificates_expiry_idx" ON "certificates" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "deployments_site_idx" ON "deployments" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dns_records_domain_idx" ON "dns_records" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dns_records_unique" ON "dns_records" USING btree ("domain_id","type","name","content");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_key" ON "domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "domains_site_idx" ON "domains" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_server_name_key" ON "sites" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "sites_status_idx" ON "sites" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ftp_accounts_key" ON "ftp_accounts" USING btree ("server_id","username");--> statement-breakpoint
CREATE INDEX "storage_samples_server_idx" ON "storage_samples" USING btree ("server_id","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_aliases_address_key" ON "mail_aliases" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_auth_checks_key" ON "mail_auth_checks" USING btree ("mail_domain_id","check");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_domains_domain_key" ON "mail_domains" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_forwarders_key" ON "mail_forwarders" USING btree ("source","destination");--> statement-breakpoint
CREATE INDEX "mail_log_server_ts_idx" ON "mail_log_entries" USING btree ("server_id","ts");--> statement-breakpoint
CREATE INDEX "mail_log_queue_idx" ON "mail_log_entries" USING btree ("queue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_key" ON "mailboxes" USING btree ("address");--> statement-breakpoint
CREATE INDEX "mailboxes_domain_idx" ON "mailboxes" USING btree ("mail_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "db_databases_key" ON "db_databases" USING btree ("instance_id","name");--> statement-breakpoint
CREATE INDEX "db_databases_server_idx" ON "db_databases" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "db_grants_key" ON "db_grants" USING btree ("database_id","db_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "db_instances_key" ON "db_instances" USING btree ("server_id","engine","port");--> statement-breakpoint
CREATE UNIQUE INDEX "db_users_key" ON "db_users" USING btree ("instance_id","username","host_pattern");--> statement-breakpoint
CREATE INDEX "firewall_rules_server_idx" ON "firewall_rules" USING btree ("server_id","priority");--> statement-breakpoint
CREATE INDEX "ip_blocks_server_idx" ON "ip_blocks" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_blocks_key" ON "ip_blocks" USING btree ("server_id","cidr");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_fingerprint_key" ON "ssh_keys" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "ssh_sessions_server_idx" ON "ssh_sessions" USING btree ("server_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threat_events_key" ON "threat_events" USING btree ("server_id","kind","source_ip");--> statement-breakpoint
CREATE INDEX "threat_events_last_seen_idx" ON "threat_events" USING btree ("last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_destinations_name_key" ON "backup_destinations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "backup_runs_schedule_idx" ON "backup_runs" USING btree ("schedule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_schedules_name_key" ON "backup_schedules" USING btree ("name");--> statement-breakpoint
CREATE INDEX "backup_schedules_next_run_idx" ON "backup_schedules" USING btree ("next_run_at") WHERE "backup_schedules"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "restore_points_snapshot_key" ON "restore_points" USING btree ("server_id","snapshot_id");--> statement-breakpoint
CREATE INDEX "restore_points_taken_idx" ON "restore_points" USING btree ("taken_at");