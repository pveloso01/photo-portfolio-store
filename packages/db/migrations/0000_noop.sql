-- 0000 no-op migration. Establishes the migrations table.
-- Real schemas land in M1.
create schema if not exists app;
