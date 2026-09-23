-- Local and CI password only. Production cloud-init rotates it on first boot.
-- The application role is not the table owner and cannot bypass row security.
CREATE ROLE app_rw WITH LOGIN PASSWORD 'app_rw_local'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

CREATE ROLE app_reception WITH LOGIN PASSWORD 'app_reception_local'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- FR-1.1.7: one clinic's query cannot hold a pooled connection indefinitely.
ALTER ROLE app_rw SET statement_timeout = '10s';
ALTER ROLE app_reception SET statement_timeout = '10s';
