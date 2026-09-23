-- M4 recall, packages, inventory and proxy consent. Configuration, not a vertical branch.

CREATE TABLE recall_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  trigger      text NOT NULL CHECK (trigger IN ('procedure_completed','plan_dormant','age_months','last_visit')),
  trigger_ref  text,
  offset_days  int NOT NULL,
  template_key text NOT NULL,
  max_attempts int NOT NULL DEFAULT 2,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE recalls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  rule_id    uuid NOT NULL REFERENCES recall_rules(id),
  due_on     date NOT NULL,
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','booked','declined','expired')),
  attempts   int NOT NULL DEFAULT 0,
  UNIQUE (clinic_id, patient_id, rule_id, due_on)
);

CREATE INDEX recalls_due ON recalls (clinic_id, due_on) WHERE state = 'pending';

CREATE TABLE package_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sessions     int NOT NULL CHECK (sessions > 0),
  price_paise  bigint NOT NULL,
  valid_days   int,
  min_gap_days int
);

CREATE TABLE patient_packages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES package_definitions(id),
  purchased_at  timestamptz NOT NULL DEFAULT now(),
  expires_on    date,
  sessions_used int NOT NULL DEFAULT 0 CHECK (sessions_used >= 0)
);

CREATE TABLE package_redemptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  package_id     uuid NOT NULL REFERENCES patient_packages(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  UNIQUE (package_id, appointment_id)
);

CREATE FUNCTION redeem_package() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  updated int;
BEGIN
  UPDATE patient_packages AS held
  SET sessions_used = held.sessions_used + 1
  FROM package_definitions AS def
  WHERE held.id = NEW.package_id
    AND def.id = held.definition_id
    AND held.sessions_used < def.sessions
    AND (held.expires_on IS NULL OR held.expires_on >= current_date);
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated = 0 THEN
    RAISE EXCEPTION 'package overdrawn';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER package_redeem
  BEFORE INSERT ON package_redemptions
  FOR EACH ROW EXECUTE FUNCTION redeem_package();

CREATE TABLE inventory_items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name      text NOT NULL,
  UNIQUE (clinic_id, name)
);

CREATE TABLE inventory_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES inventory_items(id),
  batch_no      text NOT NULL,
  expires_on    date NOT NULL,
  qty_received  int NOT NULL CHECK (qty_received > 0),
  qty_remaining int NOT NULL CHECK (qty_remaining >= 0),
  UNIQUE (clinic_id, item_id, batch_no)
);

CREATE INDEX inventory_batches_expiry ON inventory_batches (clinic_id, expires_on) WHERE qty_remaining > 0;

CREATE TABLE inventory_issues (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  batch_id       uuid NOT NULL REFERENCES inventory_batches(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  qty            int NOT NULL CHECK (qty > 0),
  amount_paise   bigint NOT NULL
);

CREATE TABLE expiry_notices (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  batch_id  uuid NOT NULL REFERENCES inventory_batches(id) ON DELETE CASCADE,
  PRIMARY KEY (clinic_id, batch_id)
);

CREATE TABLE patient_relationships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  guardian_id       uuid NOT NULL REFERENCES patients(id),
  dependant_id      uuid NOT NULL REFERENCES patients(id),
  relationship      text NOT NULL CHECK (relationship IN ('parent','legal_guardian','spouse','carer')),
  may_book          boolean NOT NULL DEFAULT true,
  may_consent       boolean NOT NULL DEFAULT false,
  may_view_clinical boolean NOT NULL DEFAULT false,
  valid_until       date,
  CHECK (guardian_id <> dependant_id),
  UNIQUE (clinic_id, guardian_id, dependant_id)
);

CREATE TABLE proxy_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  guardian_id   uuid NOT NULL REFERENCES patients(id),
  dependant_id  uuid NOT NULL REFERENCES patients(id),
  relationship  text NOT NULL,
  snapshot      jsonb NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX recovered_revenue_plan
  ON recovered_revenue (evidence_ref)
  WHERE corrects_id IS NULL AND amount_paise >= 0 AND event_type = 'plan_resumed';

CREATE UNIQUE INDEX recovered_revenue_consumable
  ON recovered_revenue (evidence_ref)
  WHERE corrects_id IS NULL AND amount_paise >= 0 AND event_type = 'consumable_billed';

CREATE OR REPLACE FUNCTION erase_clinic(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM proxy_consents WHERE clinic_id = p_id;
  DELETE FROM patient_relationships WHERE clinic_id = p_id;
  DELETE FROM expiry_notices WHERE clinic_id = p_id;
  DELETE FROM inventory_issues WHERE clinic_id = p_id;
  DELETE FROM inventory_batches WHERE clinic_id = p_id;
  DELETE FROM inventory_items WHERE clinic_id = p_id;
  DELETE FROM package_redemptions WHERE clinic_id = p_id;
  DELETE FROM patient_packages WHERE clinic_id = p_id;
  DELETE FROM package_definitions WHERE clinic_id = p_id;
  DELETE FROM recalls WHERE clinic_id = p_id;
  DELETE FROM recall_rules WHERE clinic_id = p_id;
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

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'recall_rules','recalls','package_definitions','patient_packages','package_redemptions',
    'inventory_items','inventory_batches','inventory_issues','expiry_notices',
    'patient_relationships','proxy_consents'
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
  recall_rules, recalls, package_definitions, patient_packages, package_redemptions,
  inventory_items, inventory_batches, inventory_issues, expiry_notices,
  patient_relationships, proxy_consents
  TO app_rw;

CREATE FUNCTION list_clinic_ids() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM clinics
$$;
REVOKE ALL ON FUNCTION list_clinic_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_clinic_ids() TO app_rw;
