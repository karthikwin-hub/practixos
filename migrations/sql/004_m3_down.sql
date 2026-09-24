DROP FUNCTION IF EXISTS upsert_identity(text, text, text, bytea);
DROP FUNCTION IF EXISTS lookup_identity(text);
DROP FUNCTION IF EXISTS identity_memberships(uuid);
DROP FUNCTION IF EXISTS create_identity_session(text, uuid);
DROP FUNCTION IF EXISTS resolve_identity_session(text);

DROP TABLE IF EXISTS fee_lines;
DROP TABLE IF EXISTS settlements;
DROP TABLE IF EXISTS calendar_outbound;
DROP TABLE IF EXISTS calendar_events;
DROP TABLE IF EXISTS work_orders;
DROP TABLE IF EXISTS work_order_types;
DROP TABLE IF EXISTS treatment_steps;
DROP TABLE IF EXISTS tooth_charts;
DROP TABLE IF EXISTS identity_sessions;
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_identity_fk;
ALTER TABLE staff_users DROP COLUMN IF EXISTS identity_id;
ALTER TABLE staff_users DROP COLUMN IF EXISTS practitioner_id;
ALTER TABLE staff_users DROP COLUMN IF EXISTS split_bps;
DROP TABLE IF EXISTS staff_identities;

ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check
  CHECK (role IN ('owner','admin','reception','nurse'));

ALTER TABLE appointments DROP COLUMN IF EXISTS external_hold;
ALTER TABLE clinics DROP COLUMN IF EXISTS remake_cost_paise;

DROP INDEX IF EXISTS recovered_revenue_attendance;
DROP INDEX IF EXISTS recovered_revenue_remake;
CREATE UNIQUE INDEX recovered_revenue_one_attribution
  ON recovered_revenue (appointment_id)
  WHERE corrects_id IS NULL AND amount_paise >= 0;

DROP FUNCTION resolve_staff_session(text);
CREATE FUNCTION resolve_staff_session(p_token text)
RETURNS TABLE (clinic_id uuid, user_id uuid, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.clinic_id, s.user_id, u.role
  FROM staff_sessions s
  JOIN staff_users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now()
$$;
GRANT EXECUTE ON FUNCTION resolve_staff_session(text) TO app_rw;

CREATE OR REPLACE FUNCTION erase_clinic(p_id uuid) RETURNS void
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
