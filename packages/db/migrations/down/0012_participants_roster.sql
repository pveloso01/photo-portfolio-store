-- Down migration for 0012_participants_roster.

DROP TABLE IF EXISTS "app"."roster_imports";
DROP TABLE IF EXISTS "app"."participants";
DROP TYPE IF EXISTS "app"."roster_import_status";
