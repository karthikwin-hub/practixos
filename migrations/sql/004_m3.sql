-- M3 dental chart, lab orders, consultant membership and settlement.

ALTER TABLE clinics
  ADD COLUMN remake_cost_paise bigint NOT NULL DEFAULT 140000;

ALTER TABLE appointments
  ADD COLUMN external_hold boolean NOT NULL DEFAULT false;

ALTER TABLE staff_users DROP CONSTRAINT staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check
  CHECK (role IN ('owner','admin','reception','nurse','consultant'));

ALTER TABLE staff_users
  ADD COLUMN identity_id uuid,
  ADD COLUMN practitioner_id uuid REFERENCES practitioners(id),
  ADD COLUMN split_bps int NOT NULL DEFAULT 6000 CHECK (split_bps BETWEEN 0 AND 10000);

CREATE TABLE staff_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  password_salt bytea NOT NULL
);

ALTER TABLE staff_users
  ADD CONSTRAINT staff_users_identity_fk
  FOREIGN KEY (identity_id) REFERENCES staff_identities(id);

CREATE TABLE identity_sessions (
  token       text PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES staff_identities(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);

CREATE TABLE tooth_charts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tooth_fdi  int NOT NULL,
  state      text NOT NULL CHECK (state IN ('healthy','caries','rct','crown','missing')),
  label      text NOT NULL,
  colour     text NOT NULL,
  pattern    text,
  UNIQUE (clinic_id, patient_id, tooth_fdi)
);

CREATE TABLE treatment_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id   uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tooth_fdi    int NOT NULL,
  step_no      int NOT NULL,
  name         text NOT NULL,
  fee_paise    bigint NOT NULL,
  minutes      int NOT NULL,
  consumables  text[] NOT NULL DEFAULT '{}',
  needs_lab    boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','chair','done')),
  UNIQUE (clinic_id, patient_id, tooth_fdi, step_no)
);

CREATE TABLE work_order_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  type_key        text NOT NULL,
  required_fields text[] NOT NULL,
  UNIQUE (clinic_id, type_key)
);

CREATE TABLE work_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  type_id        uuid NOT NULL REFERENCES work_order_types(id),
  lab_name       text,
  fields         jsonb NOT NULL DEFAULT '{}',
  due_on         date,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','dispatched')),
  receipt_id     text
);

CREATE TABLE calendar_events (
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  clinic_id         uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id    uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE calendar_outbound (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fee_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  practitioner_id  uuid NOT NULL REFERENCES practitioners(id),
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  gross_paise      bigint NOT NULL,
  lab_paise        bigint NOT NULL,
  consumable_paise bigint NOT NULL,
  split_bps        int NOT NULL,
  net_paise        bigint NOT NULL,
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','requested','approved','disputed','paid')),
  settlement_id    uuid
);

CREATE TABLE settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  status          text NOT NULL CHECK (status IN ('requested','approved','disputed','paid')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fee_lines
  ADD CONSTRAINT fee_lines_settlement_fk
  FOREIGN KEY (settlement_id) REFERENCES settlements(id);

DROP INDEX recovered_revenue_one_attribution;

CREATE UNIQUE INDEX recovered_revenue_attendance
  ON recovered_revenue (appointment_id)
  WHERE corrects_id IS NULL AND amount_paise >= 0
    AND event_type IN ('no_show_prevented','deposit_converted');

CREATE UNIQUE INDEX recovered_revenue_remake
  ON recovered_revenue (evidence_ref)
  WHERE corrects_id IS NULL AND amount_paise >= 0
    AND event_type = 'remake_avoided';

CREATE FUNCTION upsert_identity(p_email text, p_name text, p_hash text, p_salt bytea)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  found uuid;
BEGIN
  SELECT id INTO found FROM staff_identities WHERE email = p_email;
  IF found IS NULL THEN
    INSERT INTO staff_identities (email, full_name, password_hash, password_salt)
    VALUES (p_email, p_name, p_hash, p_salt)
    RETURNING id INTO found;
  END IF;
  RETURN found;
END;
$$;

CREATE FUNCTION lookup_identity(p_email text)
RETURNS TABLE (id uuid, full_name text, password_hash text, password_salt bytea)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, full_name, password_hash, password_salt FROM staff_identities WHERE email = p_email
$$;

CREATE FUNCTION identity_memberships(p_identity uuid)
RETURNS TABLE (clinic_id uuid, user_id uuid, role text, slug text, display_name text, practitioner_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.clinic_id, u.id, u.role, c.slug, c.display_name, u.practitioner_id
  FROM staff_users u
  JOIN clinics c ON c.id = u.clinic_id
  WHERE u.identity_id = p_identity
$$;

CREATE FUNCTION create_identity_session(p_token text, p_identity uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO identity_sessions (token, identity_id, expires_at)
  VALUES (p_token, p_identity, now() + interval '12 hours')
$$;

CREATE FUNCTION resolve_identity_session(p_token text)
RETURNS TABLE (identity_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT identity_id FROM identity_sessions WHERE token = p_token AND expires_at > now()
$$;

DROP FUNCTION resolve_staff_session(text);
CREATE FUNCTION resolve_staff_session(p_token text)
RETURNS TABLE (clinic_id uuid, user_id uuid, role text, identity_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.clinic_id, s.user_id, u.role, u.identity_id
  FROM staff_sessions s
  JOIN staff_users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now()
$$;

CREATE OR REPLACE FUNCTION erase_clinic(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM fee_lines WHERE clinic_id = p_id;
  DELETE FROM settlements WHERE clinic_id = p_id;
  DELETE FROM calendar_outbound WHERE clinic_id = p_id;
  DELETE FROM calendar_events WHERE clinic_id = p_id;
  DELETE FROM work_orders WHERE clinic_id = p_id;
  DELETE FROM work_order_types WHERE clinic_id = p_id;
  DELETE FROM treatment_steps WHERE clinic_id = p_id;
  DELETE FROM tooth_charts WHERE clinic_id = p_id;
  DELETE FROM patient_sessions WHERE clinic_id = p_id;
  DELETE FROM otp_challenges WHERE clinic_id = p_id;
  DELETE FROM staff_sessions WHERE clinic_id = p_id;
  DELETE FROM deposits WHERE clinic_id = p_id;
  DELETE FROM payment_events WHERE clinic_id = p_id;
  DELETE FROM message_outbox WHERE clinic_id = p_id;
  DELETE FROM vitals WHERE clinic_id = p_id;
  DELETE FROM sync_applied WHERE clinic_id = p_id;
  DELETE FROM import_batches WHERE clinic_id = p_id;
  DELETE FROM appointments WHERE clinic_id = p_id;
  DELETE FROM vault_notes WHERE clinic_id = p_id;
  DELETE FROM patients WHERE clinic_id = p_id;
  DELETE FROM staff_users WHERE clinic_id = p_id;
  DELETE FROM queue_stages WHERE clinic_id = p_id;
  DELETE FROM clinic_modules WHERE clinic_id = p_id;
  DELETE FROM working_hours WHERE clinic_id = p_id;
  DELETE FROM break_windows WHERE clinic_id = p_id;
  DELETE FROM practitioners WHERE clinic_id = p_id;
  DELETE FROM chairs WHERE clinic_id = p_id;
  DELETE FROM clinics WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION upsert_identity(text, text, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity_memberships(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_identity_session(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_identity_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_identity(text, text, text, bytea) TO app_rw;
GRANT EXECUTE ON FUNCTION lookup_identity(text) TO app_rw;
GRANT EXECUTE ON FUNCTION identity_memberships(uuid) TO app_rw;
GRANT EXECUTE ON FUNCTION create_identity_session(text, uuid) TO app_rw;
GRANT EXECUTE ON FUNCTION resolve_identity_session(text) TO app_rw;
GRANT EXECUTE ON FUNCTION resolve_staff_session(text) TO app_rw;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tooth_charts','treatment_steps','work_order_types','work_orders',
    'calendar_events','calendar_outbound','fee_lines','settlements'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY clinic_isolation ON %I USING (clinic_id = NULLIF(current_setting(''app.clinic_id'', true), '''')::uuid) WITH CHECK (clinic_id = NULLIF(current_setting(''app.clinic_id'', true), '''')::uuid)',
      tbl
    );
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tooth_charts, treatment_steps, work_order_types, work_orders,
  calendar_events, calendar_outbound, fee_lines, settlements
  TO app_rw;
