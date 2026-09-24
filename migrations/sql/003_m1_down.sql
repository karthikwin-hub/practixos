DROP FUNCTION IF EXISTS resolve_patient_session(text);
DROP FUNCTION IF EXISTS resolve_staff_session(text);
DROP FUNCTION IF EXISTS erase_clinic(uuid);
DROP FUNCTION IF EXISTS provision_clinic(text, text, text);
DROP FUNCTION IF EXISTS resolve_clinic_id(text);

DROP TABLE IF EXISTS sync_applied, vitals, import_batches, message_outbox,
  payment_events, deposits, patient_sessions, otp_challenges, staff_sessions,
  staff_users, clinic_modules, break_windows, working_hours;

DROP TABLE IF EXISTS recovered_revenue;
DROP FUNCTION IF EXISTS reject_ledger_mutation();

ALTER TABLE appointments
  DROP COLUMN IF EXISTS token_no,
  DROP COLUMN IF EXISTS stage_id,
  DROP COLUMN IF EXISTS arrived_at,
  DROP COLUMN IF EXISTS attended_at,
  DROP COLUMN IF EXISTS patient_confirmed,
  DROP COLUMN IF EXISTS updated_at;

DROP TABLE IF EXISTS queue_stages;

ALTER TABLE clinics
  DROP COLUMN IF EXISTS display_name,
  DROP COLUMN IF EXISTS mark,
  DROP COLUMN IF EXISTS accent,
  DROP COLUMN IF EXISTS languages,
  DROP COLUMN IF EXISTS registration_no,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS prepay_required,
  DROP COLUMN IF EXISTS slot_minutes,
  DROP COLUMN IF EXISTS standard_fee_paise,
  DROP COLUMN IF EXISTS wizard_step,
  DROP COLUMN IF EXISTS wizard_draft,
  DROP COLUMN IF EXISTS messaging_cap,
  DROP COLUMN IF EXISTS messaging_sent,
  DROP COLUMN IF EXISTS attribution_hours;
