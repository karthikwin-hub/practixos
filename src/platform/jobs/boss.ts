/**
 * Audited exemption from the withTenant lint rule.
 * pg-boss owns its queue tables and has no request context.
 * A tenant-scoped job must carry clinic_id and run inside withTenant.
 * No jobs are registered in M0.
 */
export {};
