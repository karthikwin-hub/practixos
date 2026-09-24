ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS subscription_paise bigint NOT NULL DEFAULT 199900,
  ADD COLUMN IF NOT EXISTS overhead_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS value_source text NOT NULL DEFAULT 'default';

ALTER TABLE clinics DROP CONSTRAINT IF EXISTS clinics_value_source_check;
ALTER TABLE clinics
  ADD CONSTRAINT clinics_value_source_check CHECK (value_source IN ('default', 'clinic'));

CREATE TABLE IF NOT EXISTS cash_handovers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id),
  day        date NOT NULL,
  cash_paise bigint NOT NULL,
  UNIQUE (clinic_id, day)
);

CREATE TABLE IF NOT EXISTS clinic_dhis_rates (
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  category       int  NOT NULL CHECK (category IN (1, 2)),
  facility_paise int  NOT NULL,
  PRIMARY KEY (clinic_id, category)
);

CREATE TABLE IF NOT EXISTS dhis_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id),
  abha_id       text NOT NULL,
  category      int  NOT NULL CHECK (category IN (1, 2)),
  kyc_verified  boolean NOT NULL,
  bundle_ref    text NOT NULL,
  occurred_on   date NOT NULL,
  kind          text NOT NULL,
  UNIQUE (clinic_id, bundle_ref)
);

CREATE TABLE IF NOT EXISTS consult_spans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinics(id),
  practitioner_id  uuid NOT NULL REFERENCES practitioners(id),
  session_type     text NOT NULL,
  minutes          int  NOT NULL CHECK (minutes > 0)
);

CREATE TABLE IF NOT EXISTS care_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id),
  procedure_key text NOT NULL,
  delay_hours   int  NOT NULL,
  lang          text NOT NULL,
  body          text NOT NULL,
  UNIQUE (clinic_id, procedure_key, lang)
);

CREATE TABLE IF NOT EXISTS token_notices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  appointment_id  uuid NOT NULL REFERENCES appointments(id),
  quoted_minutes  int  NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION erase_clinic(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM token_notices WHERE clinic_id = p_id;
  DELETE FROM care_templates WHERE clinic_id = p_id;
  DELETE FROM consult_spans WHERE clinic_id = p_id;
  DELETE FROM dhis_transactions WHERE clinic_id = p_id;
  DELETE FROM clinic_dhis_rates WHERE clinic_id = p_id;
  DELETE FROM cash_handovers WHERE clinic_id = p_id;
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
    'cash_handovers','clinic_dhis_rates','dhis_transactions','consult_spans',
    'care_templates','token_notices'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS clinic_isolation ON %I', tbl);
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
  cash_handovers, clinic_dhis_rates, dhis_transactions, consult_spans,
  care_templates, token_notices
  TO app_rw;
