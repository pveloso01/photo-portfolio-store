-- F1.23 — enable Postgres extensions used by name-search fuzzy matching.
--   pg_trgm        — similarity()/% operators for trigram-based ranking
--   fuzzystrmatch  — levenshtein()/soundex() for additional fuzzy ops
--
-- Both are part of contrib and ship with mainline Postgres distributions
-- (RDS, Cloud SQL, self-hosted). The application checks at startup and
-- falls back to ILIKE if either is missing.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
