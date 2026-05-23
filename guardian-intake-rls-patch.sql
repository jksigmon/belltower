-- ============================================================
-- Guardian Intake: anon access policies + matching trigger
-- Run AFTER guardian-intake-migration.sql
-- ============================================================

-- Allow unauthenticated visitors to read active campaigns by token.
-- The UUID token (122-bit entropy) acts as the authorization.
CREATE POLICY "intake_campaigns_anon_read"
  ON public.guardian_intake_campaigns
  FOR SELECT
  TO anon
  USING (status = 'active');

-- Allow unauthenticated visitors to submit to an active campaign.
CREATE POLICY "intake_submissions_anon_insert"
  ON public.guardian_intake_submissions
  FOR INSERT
  TO anon
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.guardian_intake_campaigns c
      WHERE c.id = guardian_intake_submissions.campaign_id
        AND c.school_id = guardian_intake_submissions.school_id
        AND c.status = 'active'
    )
  );

-- ── Matching trigger ─────────────────────────────────────────
-- Runs on every INSERT, fills match_confidence + match_candidates
-- using SECURITY DEFINER so it can read guardians regardless of RLS.

CREATE OR REPLACE FUNCTION public.compute_intake_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_guardian_id uuid;
  v_candidates  jsonb := '[]'::jsonb;
  v_confidence  text  := 'none';
  v_norm_sub    text;
  v_norm_g      text;
BEGIN
  -- 1. Email exact match → HIGH (100)
  IF NEW.email IS NOT NULL AND NEW.email <> '' THEN
    SELECT id INTO v_guardian_id
    FROM guardians
    WHERE school_id = NEW.school_id
      AND active    = true
      AND lower(trim(email)) = lower(trim(NEW.email))
    LIMIT 1;

    IF FOUND THEN
      v_candidates := jsonb_build_array(
        jsonb_build_object('guardian_id', v_guardian_id, 'score', 100, 'reasons', jsonb_build_array('email_exact'))
      );
      v_confidence := 'high';
      NEW.match_confidence := v_confidence;
      NEW.match_candidates := v_candidates;
      RETURN NEW;
    END IF;
  END IF;

  -- 2. Phone exact match (digits only) → HIGH (90)
  IF NEW.phone_cell IS NOT NULL AND NEW.phone_cell <> '' THEN
    v_norm_sub := regexp_replace(NEW.phone_cell, '\D', '', 'g');
    IF length(v_norm_sub) >= 7 THEN
      SELECT id INTO v_guardian_id
      FROM guardians
      WHERE school_id = NEW.school_id
        AND active    = true
        AND regexp_replace(phone, '\D', '', 'g') = v_norm_sub
      LIMIT 1;

      IF FOUND THEN
        v_candidates := jsonb_build_array(
          jsonb_build_object('guardian_id', v_guardian_id, 'score', 90, 'reasons', jsonb_build_array('phone_match'))
        );
        v_confidence := 'high';
        NEW.match_confidence := v_confidence;
        NEW.match_candidates := v_candidates;
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  -- 3. First + last name exact match → MEDIUM (70)
  IF NEW.first_name IS NOT NULL AND NEW.last_name IS NOT NULL THEN
    SELECT id INTO v_guardian_id
    FROM guardians
    WHERE school_id  = NEW.school_id
      AND active     = true
      AND lower(trim(first_name)) = lower(trim(NEW.first_name))
      AND lower(trim(last_name))  = lower(trim(NEW.last_name))
    LIMIT 1;

    IF FOUND THEN
      v_candidates := jsonb_build_array(
        jsonb_build_object('guardian_id', v_guardian_id, 'score', 70, 'reasons', jsonb_build_array('name_exact'))
      );
      v_confidence := 'medium';
    END IF;
  END IF;

  NEW.match_confidence := v_confidence;
  NEW.match_candidates := v_candidates;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intake_submission_match
  BEFORE INSERT ON public.guardian_intake_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_intake_match();
