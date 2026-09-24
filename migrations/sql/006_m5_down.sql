DROP TABLE IF EXISTS token_notices;
DROP TABLE IF EXISTS care_templates;
DROP TABLE IF EXISTS consult_spans;
DROP TABLE IF EXISTS dhis_transactions;
DROP TABLE IF EXISTS clinic_dhis_rates;
DROP TABLE IF EXISTS cash_handovers;

ALTER TABLE clinics
  DROP COLUMN IF EXISTS subscription_paise,
  DROP COLUMN IF EXISTS overhead_paise,
  DROP COLUMN IF EXISTS value_source;

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
