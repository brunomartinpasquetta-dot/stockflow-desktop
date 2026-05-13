ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "licenses_quota" integer NOT NULL DEFAULT 1;
