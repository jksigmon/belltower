-- ============================================================
-- Guardian Intake: campaigns + submissions
-- Run in Supabase SQL editor
-- ============================================================

-- ── Campaigns ────────────────────────────────────────────────
CREATE TABLE public.guardian_intake_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name        text NOT NULL,
  token       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
  created_by  uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

ALTER TABLE public.guardian_intake_campaigns ENABLE ROW LEVEL SECURITY;

-- Admins (can_manage_guardians or can_manage_families) can do everything
CREATE POLICY "intake_campaigns_admin_all"
  ON public.guardian_intake_campaigns
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = guardian_intake_campaigns.school_id
        AND (p.can_manage_guardians OR p.can_manage_families OR p.is_superadmin)
    )
  );

-- All authenticated staff at the same school can read active campaigns (for share-link feature)
CREATE POLICY "intake_campaigns_staff_read"
  ON public.guardian_intake_campaigns
  FOR SELECT
  USING (
    status = 'active'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = guardian_intake_campaigns.school_id
        AND p.can_login = true
    )
  );

-- ── Submissions ───────────────────────────────────────────────
CREATE TABLE public.guardian_intake_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES public.guardian_intake_campaigns(id) ON DELETE CASCADE,
  school_id     uuid NOT NULL REFERENCES public.schools(id),
  submitted_at  timestamptz NOT NULL DEFAULT now(),

  -- What the parent entered
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  email         text,
  phone_cell    text,
  relationship  text,
  ok_to_text    boolean NOT NULL DEFAULT false,
  students      jsonb   NOT NULL DEFAULT '[]'::jsonb,

  -- Auto-match written at submit time (service role, bypasses RLS)
  match_confidence  text CHECK (match_confidence IN ('high', 'medium', 'none')),
  match_candidates  jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Admin review
  review_status       text NOT NULL DEFAULT 'pending'
                       CHECK (review_status IN ('pending', 'accepted', 'partial', 'discarded', 'merged')),
  matched_guardian_id uuid REFERENCES public.guardians(id) ON DELETE SET NULL,
  matched_family_id   uuid REFERENCES public.families(id)  ON DELETE SET NULL,
  merged_into_id      uuid REFERENCES public.guardian_intake_submissions(id) ON DELETE SET NULL,
  review_notes        text,
  reviewed_by         uuid REFERENCES public.profiles(id),
  reviewed_at         timestamptz
);

ALTER TABLE public.guardian_intake_submissions ENABLE ROW LEVEL SECURITY;

-- Admins can read and update submissions for their school
CREATE POLICY "intake_submissions_admin_all"
  ON public.guardian_intake_submissions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.school_id = guardian_intake_submissions.school_id
        AND (p.can_manage_guardians OR p.can_manage_families OR p.is_superadmin)
    )
  );

-- Edge function inserts via service role key — bypasses RLS, no insert policy needed.

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX intake_campaigns_school_id_idx    ON public.guardian_intake_campaigns (school_id);
CREATE INDEX intake_campaigns_token_idx        ON public.guardian_intake_campaigns (token);
CREATE INDEX intake_submissions_campaign_idx   ON public.guardian_intake_submissions (campaign_id);
CREATE INDEX intake_submissions_school_idx     ON public.guardian_intake_submissions (school_id);
CREATE INDEX intake_submissions_status_idx     ON public.guardian_intake_submissions (review_status);
CREATE INDEX intake_submissions_confidence_idx ON public.guardian_intake_submissions (match_confidence);
