-- notify_pto_event() called net.http_post() against send_pto_notifications
-- with only a Content-Type header. That edge function requires a valid
-- Supabase JWT (verify_jwt is on), so every trigger firing has been getting
-- a 401 UNAUTHORIZED_NO_AUTH_HEADER from pg_net and silently dropping the
-- notification — confirmed via net._http_response on belltower-dev
-- (lmvpjbzwdyfziedpeytd). Not related to the PTO->Leave wording change;
-- this call has likely never worked. Fix: send the project's anon key as
-- apikey/Authorization, same as the browser client does — the function
-- itself uses SUPABASE_SERVICE_ROLE_KEY internally to do the privileged
-- work, so the caller's JWT only needs to pass verify_jwt, not carry
-- elevated rights. The anon key is already public (shipped in
-- app/config.js), so embedding it here isn't a new exposure.
--
-- NOTE: this project's URL/key are environment-specific (matching the
-- existing pattern where the function URL itself was already hardcoded
-- per-environment). This file has belltower-dev's values. The equivalent
-- statement must be re-run by hand against belltower-prod with prod's own
-- anon key before this trigger will work there.

CREATE OR REPLACE FUNCTION public.notify_pto_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$BEGIN
  PERFORM
    net.http_post(
      url := 'https://lmvpjbzwdyfziedpeytd.functions.supabase.co/send_pto_notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtdnBqYnp3ZHlmemllZHBleXRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODY5MTcsImV4cCI6MjA4OTI2MjkxN30.b1X1ru4NYlkDjHlsxZ82ZOwbVoZ_PhRsjf4Atfwa5G0',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtdnBqYnp3ZHlmemllZHBleXRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODY5MTcsImV4cCI6MjA4OTI2MjkxN30.b1X1ru4NYlkDjHlsxZ82ZOwbVoZ_PhRsjf4Atfwa5G0'
      ),
      body := jsonb_build_object(
        'event', TG_OP,
        'old_status', OLD.status,
        'new_status', NEW.status,
        'pto_request_id', NEW.id
      )
    );

  RETURN NEW;
END;$$;
