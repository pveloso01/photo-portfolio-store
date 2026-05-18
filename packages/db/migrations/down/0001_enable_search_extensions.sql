-- Down migration for 0001_enable_search_extensions.
-- Drops fuzzystrmatch + pg_trgm. Note: any indexes or columns that depend
-- on these extensions must already have been dropped before running this.

DROP EXTENSION IF EXISTS fuzzystrmatch;
DROP EXTENSION IF EXISTS pg_trgm;
