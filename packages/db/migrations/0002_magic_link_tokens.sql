CREATE TABLE IF NOT EXISTS "app"."magic_link_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email_lower" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "ip_hash" text,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "magic_link_tokens_email_idx" ON "app"."magic_link_tokens" ("email_lower", "expires_at");
