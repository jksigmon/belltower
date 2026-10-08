-- One-time backfill: compliance_agreements.expires_at was never set, so every
-- signed agreement was treated as valid forever. Agreements now expire at the
-- next Aug 1 school-year cutover (see supabase/functions/compliance_form_submit).
-- Every existing unexpired-by-default agreement is given the 2027-08-01 expiry,
-- so current signers stay valid through the 2026-27 school year and re-sign next year.

update public.compliance_agreements
set expires_at = date '2027-08-01'
where expires_at is null
  and voided_at is null;
