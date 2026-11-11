ALTER TABLE "app_installs" ADD COLUMN "app_port" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "app_installs_server_port_idx" ON "app_installs" USING btree ("server_id","app_port") WHERE "app_installs"."app_port" is not null;
