-- 0001_calibration_store.sql
--
-- Calibration profile/revision store for the Color Match Studio API.
-- Applied by api/pg/migrate.ts; {{schema}} is replaced with a validated,
-- double-quoted schema identifier before the statement is executed.
--
-- Invariants enforced here (not only in the API):
--   * revisions are append-only: UPDATE/DELETE/TRUNCATE raise an exception
--   * a revision number is unique per profile and starts at 1
--   * revision content is stored as JSONB and guarded by shape/format checks
--   * idempotency keys resolve to exactly one stored revision

CREATE TABLE IF NOT EXISTS {{schema}}.profiles (
  id text NOT NULL,
  name text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT profiles_timestamps_positive CHECK (created_at > 0 AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS {{schema}}.revisions (
  profile_id text NOT NULL,
  revision integer NOT NULL,
  points_json jsonb NOT NULL,
  matrix_json jsonb NOT NULL,
  mode text NOT NULL,
  algorithm_version text NOT NULL,
  fingerprint text NOT NULL,
  content_hash text NOT NULL,
  provenance_json jsonb NOT NULL,
  mean_residual double precision NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT revisions_pkey PRIMARY KEY (profile_id, revision),
  CONSTRAINT revisions_profile_fk FOREIGN KEY (profile_id)
    REFERENCES {{schema}}.profiles (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT revisions_mode_valid CHECK (mode IN ('simple', 'advanced')),
  CONSTRAINT revisions_fingerprint_format CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  CONSTRAINT revisions_content_hash_format CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT revisions_points_array CHECK (jsonb_typeof(points_json) = 'array'),
  CONSTRAINT revisions_matrix_object CHECK (jsonb_typeof(matrix_json) = 'object'),
  CONSTRAINT revisions_provenance_object CHECK (jsonb_typeof(provenance_json) = 'object'),
  CONSTRAINT revisions_mean_residual_finite CHECK (
    mean_residual <> 'NaN'::float8
    AND mean_residual <> 'Infinity'::float8
    AND mean_residual <> '-Infinity'::float8
  ),
  CONSTRAINT revisions_created_at_positive CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS revisions_profile_created_idx
  ON {{schema}}.revisions (profile_id, created_at);

CREATE TABLE IF NOT EXISTS {{schema}}.idempotency_keys (
  key text NOT NULL,
  profile_id text NOT NULL,
  revision integer NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (key),
  CONSTRAINT idempotency_keys_profile_fk FOREIGN KEY (profile_id)
    REFERENCES {{schema}}.profiles (id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_keys_revision_positive CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_revision_idx
  ON {{schema}}.idempotency_keys (profile_id, revision);

-- Immutability: revisions may only be inserted. The function is shared by the
-- row-level UPDATE/DELETE trigger and the statement-level TRUNCATE trigger.
CREATE OR REPLACE FUNCTION {{schema}}.reject_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $reject$
BEGIN
  RAISE EXCEPTION 'calibration revisions are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$reject$;

DROP TRIGGER IF EXISTS revisions_immutable ON {{schema}}.revisions;
CREATE TRIGGER revisions_immutable
  BEFORE UPDATE OR DELETE ON {{schema}}.revisions
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.reject_revision_mutation();

DROP TRIGGER IF EXISTS revisions_no_truncate ON {{schema}}.revisions;
CREATE TRIGGER revisions_no_truncate
  BEFORE TRUNCATE ON {{schema}}.revisions
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_revision_mutation();

COMMENT ON TABLE {{schema}}.revisions IS
  'Append-only calibration revisions; see 0001_calibration_store.sql.';
COMMENT ON TABLE {{schema}}.profiles IS
  'Calibration profiles. Revisions are addressed by profile id + explicit revision.';
COMMENT ON TABLE {{schema}}.idempotency_keys IS
  'Idempotency keys mapping a client retry to one immutable revision.';
