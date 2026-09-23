-- M1 booking, deposits and recovered-revenue capture. Queue stages are seeded
-- at onboarding (§4.6.1). Vitals and sync rows are the M2 floor.

ALTER TABLE clinics
  ADD COLUMN display_name text,
  ADD COLUMN mark text,
  ADD COLUMN accent text NOT NULL DEFAULT '#1f4b3a',
  ADD COLUMN languages text[] NOT NULL DEFAULT '{en}',
  ADD COLUMN registration_no text,
  ADD COLUMN address text,
  ADD COLUMN prepay_required boolean NOT NULL DEFAULT false,
  ADD COLUMN slot_minutes int NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 120),
  ADD COLUMN standard_fee_paise bigint NOT NULL DEFAULT 50000,
  ADD COLUMN wizard_step text NOT NULL DEFAULT 'identity',
  ADD COLUMN wizard_draft jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN messaging_cap int NOT NULL DEFAULT 1500,
  ADD COLUMN messaging_sent int NOT NULL DEFAULT 0,
  ADD COLUMN attribution_hours int NOT NULL DEFAULT 72;

UPDATE clinics SET display_name = legal_name WHERE display_name IS NULL;
ALTER TABLE clinics ALTER COLUMN display_name SET NOT NULL;

CREATE TABLE working_hours (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  weekday  int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens    time NOT NULL,
  closes   time NOT NULL,
  UNIQUE (clinic_id, weekday)
);

CREATE TABLE break_windows (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  weekday   int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts    time NOT NULL,
  ends      time NOT NULL
);

CREATE TABLE queue_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  position    int  NOT NULL,
  label_key   text NOT NULL,
  role        text NOT NULL CHECK (role IN
                ('pre_arrival','waiting','in_service','post_service','settlement')),
  dwell_alert_mins int,
  UNIQUE (clinic_id, position)
);

CREATE TABLE clinic_modules (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  module    text NOT NULL,
  PRIMARY KEY (clinic_id, module)
);

CREATE TABLE staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  email         text NOT NULL,
  full_name     text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','admin','reception','nurse')),
  password_hash text NOT NULL,
  password_salt bytea NOT NULL,
  UNIQUE (clinic_id, email)
);

CREATE TABLE staff_sessions (
  token      text PRIMARY KEY,
  clinic_id  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE otp_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  code_hash  text NOT NULL,
  salt       bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_sessions (
  token      text PRIMARY KEY,
  clinic_id  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

ALTER TABLE appointments
  ADD COLUMN token_no int,
  ADD COLUMN stage_id uuid REFERENCES queue_stages(id),
  ADD COLUMN arrived_at timestamptz,
  ADD COLUMN attended_at timestamptz,
  ADD COLUMN patient_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE deposits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id    uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  amount_paise      bigint NOT NULL,
  status            text NOT NULL CHECK (status IN
                      ('pending','settled','forfeited','refund_instructed')),
  provider          text,
  provider_event_id text,
  settled_at        timestamptz,
  UNIQUE (appointment_id)
);

CREATE TABLE payment_events (
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  clinic_id         uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE message_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  phone_e164     text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  lang           text NOT NULL,
  template       text NOT NULL,
  body           text NOT NULL,
  status         text NOT NULL CHECK (status IN ('queued','delivered')),
  receipt_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovered_revenue (
  id             bigserial PRIMARY KEY,
  clinic_id      uuid NOT NULL,
  appointment_id uuid NOT NULL,
  event_type     text NOT NULL CHECK (event_type IN (
                   'no_show_prevented','deposit_converted','plan_resumed',
                   'remake_avoided','consumable_billed')),
  amount_paise   bigint NOT NULL,
  evidence_ref   text NOT NULL,
  reason         text,
  corrects_id    bigint REFERENCES recovered_revenue(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX recovered_revenue_one_attribution
  ON recovered_revenue (appointment_id)
  WHERE corrects_id IS NULL AND amount_paise >= 0;

CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recovered_revenue is append-only';
END;
$$;

CREATE TRIGGER recovered_revenue_append_only
  BEFORE UPDATE OR DELETE ON recovered_revenue
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TABLE import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('dry_run','committed','reversed')),
  summary      jsonb NOT NULL,
  created_ids  uuid[] NOT NULL DEFAULT '{}',
  committed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vitals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  bp_systolic    int,
  bp_diastolic   int,
  pulse          int,
  sugar          int,
  weight_g       int,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_applied (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE FUNCTION resolve_clinic_id(p_slug text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM clinics WHERE slug = p_slug
$$;

CREATE FUNCTION provision_clinic(p_slug text, p_legal_name text, p_vertical text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO clinics (slug, legal_name, vertical, display_name)
  VALUES (p_slug, p_legal_name, p_vertical, p_legal_name)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE FUNCTION erase_clinic(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
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

CREATE FUNCTION resolve_staff_session(p_token text)
RETURNS TABLE (clinic_id uuid, user_id uuid, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.clinic_id, s.user_id, u.role
  FROM staff_sessions s
  JOIN staff_users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now()
$$;

CREATE FUNCTION resolve_patient_session(p_token text)
RETURNS TABLE (clinic_id uuid, patient_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT clinic_id, patient_id
  FROM patient_sessions
  WHERE token = p_token AND expires_at > now()
$$;

REVOKE ALL ON FUNCTION resolve_clinic_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_clinic(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION erase_clinic(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_clinic_id(text) TO app_rw;
GRANT EXECUTE ON FUNCTION provision_clinic(text, text, text) TO app_rw;
GRANT EXECUTE ON FUNCTION erase_clinic(uuid) TO app_rw;
REVOKE ALL ON FUNCTION resolve_staff_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_patient_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_staff_session(text) TO app_rw;
GRANT EXECUTE ON FUNCTION resolve_patient_session(text) TO app_rw;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'working_hours','break_windows','queue_stages','clinic_modules','staff_users',
    'staff_sessions','otp_challenges','patient_sessions','deposits','payment_events',
    'message_outbox','recovered_revenue','import_batches','vitals','sync_applied'
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
  working_hours, break_windows, queue_stages, clinic_modules, staff_users,
  staff_sessions, otp_challenges, patient_sessions, deposits, payment_events,
  message_outbox, import_batches, vitals, sync_applied
  TO app_rw;

GRANT INSERT, SELECT ON recovered_revenue TO app_rw;
GRANT USAGE, SELECT ON SEQUENCE recovered_revenue_id_seq TO app_rw;
REVOKE UPDATE, DELETE ON recovered_revenue FROM app_rw;
