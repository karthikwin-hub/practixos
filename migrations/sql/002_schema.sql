CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE clinics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  legal_name    text NOT NULL,
  vertical      text NOT NULL CHECK (vertical IN
                  ('dental','ophthalmology','dermatology','paediatrics',
                   'mental_health','polyclinic')),
  followup_days int  NOT NULL DEFAULT 7 CHECK (followup_days BETWEEN 3 AND 15),
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE practitioners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id),
  full_name  text NOT NULL
);

CREATE TABLE chairs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  label       text NOT NULL,
  capability  text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE patients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  full_name      text NOT NULL,
  phone_e164     text NOT NULL,
  phone_masked   text GENERATED ALWAYS AS
                   (left(phone_e164, 9) || '•••' || right(phone_e164, 2)) STORED,
  preferred_lang text NOT NULL DEFAULT 'en'
                   CHECK (preferred_lang IN ('en','mr','te','bn','kok')),
  abha_id        text,
  alerts         text[] NOT NULL DEFAULT '{}',
  self_managing  boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX patients_phone_self ON patients (clinic_id, phone_e164)
  WHERE self_managing;

CREATE TABLE appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  patient_id      uuid NOT NULL REFERENCES patients(id),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  chair_id        uuid REFERENCES chairs(id),
  during          tstzrange NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('clinic','video')),
  state           text NOT NULL DEFAULT 'expected'
                    CHECK (state IN (
                      'expected','waiting','in_consult','billing',
                      'done','no_show','cancelled'
                    )),
  fee_paise       bigint NOT NULL,
  fee_reason      text NOT NULL,
  prepaid         boolean NOT NULL DEFAULT false
);

ALTER TABLE appointments
  ADD CONSTRAINT chair_not_double_booked
  EXCLUDE USING gist (chair_id WITH =, during WITH &&)
  WHERE (chair_id IS NOT NULL AND state NOT IN ('cancelled','no_show'));

ALTER TABLE appointments
  ADD CONSTRAINT practitioner_not_double_booked
  EXCLUDE USING gist (practitioner_id WITH =, during WITH &&)
  WHERE (state NOT IN ('cancelled','no_show'));

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  actor_id   uuid,
  actor_role text NOT NULL,
  action     text NOT NULL,
  subject    text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- Ciphertext only. The server secret and the note plaintext are never columns.
CREATE TABLE vault_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id),
  salt       bytea NOT NULL,
  nonce      bytea NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Missing app.clinic_id matches zero rows (§4.4.1). FORCE applies the policy to the owner.
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinics FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON clinics
  USING (id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);

ALTER TABLE practitioners ENABLE ROW LEVEL SECURITY;
ALTER TABLE practitioners FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON practitioners
  USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);

ALTER TABLE chairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chairs FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON chairs
  USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON patients
  USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON appointments
  USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON audit_log
  USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);

ALTER TABLE vault_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON vault_notes
  USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);

GRANT USAGE ON SCHEMA public TO app_rw, app_reception;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  clinics, practitioners, chairs, patients, appointments, vault_notes
  TO app_rw;

GRANT INSERT, SELECT ON audit_log TO app_rw;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app_rw;
REVOKE UPDATE, DELETE ON audit_log FROM app_rw;

-- Table-level SELECT would include phone_e164 and a column REVOKE would not remove it.
GRANT SELECT (
  id, clinic_id, full_name, phone_masked, preferred_lang, abha_id, alerts, self_managing
) ON patients TO app_reception;
REVOKE SELECT (phone_e164) ON patients FROM app_reception;
GRANT SELECT (phone_masked) ON patients TO app_reception;
