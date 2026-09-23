-- Up Migration

-- Table-level SELECT includes phone_e164, and a column REVOKE does not remove it.
REVOKE SELECT ON patients FROM app_reception;

GRANT SELECT (
  id, clinic_id, full_name, phone_masked, preferred_lang, abha_id, alerts, self_managing
) ON patients TO app_reception;

REVOKE SELECT (phone_e164) ON patients FROM app_reception;

GRANT SELECT (phone_masked) ON patients TO app_reception;

-- Down Migration

REVOKE SELECT ON patients FROM app_reception;
