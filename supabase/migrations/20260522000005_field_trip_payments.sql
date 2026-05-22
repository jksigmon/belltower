-- ======================================================================
-- Field Trip Payments Migration
-- Run once in Supabase SQL editor.
--
-- Changes:
--   1. Add payment columns to field_trips
--   2. Create field_trip_payments  (one summary row per person per trip)
--   3. Create field_trip_payment_log (audit row per payment received)
--
-- Depends on:
--   • public.ft_get_school_id(uuid)  — SECURITY DEFINER, from field-trips-rls-final-fix.sql
--   • public.ft_is_manager(uuid, uuid) — SECURITY DEFINER, from field-trips-rls-final-fix.sql
--   • public.field_trips
--   • public.field_trip_chaperones
--   • public.students
--   • public.profiles
-- ======================================================================


-- ── 1. New payment columns on field_trips ─────────────────────────────

ALTER TABLE public.field_trips
  ADD COLUMN IF NOT EXISTS payment_required          boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS student_cost              numeric(8,2),
  ADD COLUMN IF NOT EXISTS chaperone_payment_required boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chaperone_cost            numeric(8,2),
  ADD COLUMN IF NOT EXISTS allow_installments        boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS installment_schedule      jsonb,
  ADD COLUMN IF NOT EXISTS payment_due_date          date;

-- installment_schedule stores an ordered array of payment milestones, e.g.:
-- [
--   {"label": "Deposit",     "amount": 10.00, "due_date": "2026-10-01"},
--   {"label": "2nd payment", "amount": 20.00, "due_date": "2026-11-01"},
--   {"label": "Final",       "amount": 15.00, "due_date": "2026-12-01"}
-- ]
-- The JS UI sums installments to validate they equal student_cost before saving.


-- ── 2. field_trip_payments ────────────────────────────────────────────
-- One row per (trip + student) OR (trip + chaperone).
-- amount_paid is updated each time a payment_log row is inserted.
-- status is kept in sync by application logic (not a DB trigger) so the
-- app can display it without recomputing it every time.

CREATE TABLE IF NOT EXISTS public.field_trip_payments (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  school_id         uuid        NOT NULL REFERENCES public.schools(id)                 ON DELETE CASCADE,
  field_trip_id     uuid        NOT NULL REFERENCES public.field_trips(id)             ON DELETE CASCADE,

  -- exactly one of these two is non-null
  student_id        uuid        REFERENCES public.students(id)                         ON DELETE CASCADE,
  chaperone_id      uuid        REFERENCES public.field_trip_chaperones(id)            ON DELETE CASCADE,

  payer_type        text        NOT NULL CHECK (payer_type IN ('student', 'chaperone')),
  amount_due        numeric(8,2) NOT NULL DEFAULT 0,
  amount_paid       numeric(8,2) NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'unpaid'
                      CHECK (status IN ('unpaid', 'partial', 'paid', 'waived')),
  waive_reason      text,
  notes             text,
  last_payment_date date,
  updated_by        uuid        REFERENCES public.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT field_trip_payments_pkey PRIMARY KEY (id),
  CONSTRAINT field_trip_payments_one_payer CHECK (
    (student_id IS NOT NULL AND chaperone_id IS NULL) OR
    (student_id IS NULL     AND chaperone_id IS NOT NULL)
  ),
  CONSTRAINT field_trip_payments_student_unique  UNIQUE (field_trip_id, student_id),
  CONSTRAINT field_trip_payments_chaperone_unique UNIQUE (field_trip_id, chaperone_id)
);

ALTER TABLE public.field_trip_payments ENABLE ROW LEVEL SECURITY;

-- SELECT: any authenticated user in the same school who is also a trip
-- manager (or has can_manage_field_trips / is_superadmin).
CREATE POLICY ftp_select ON public.field_trip_payments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_payments.field_trip_id)
            AND (
              p.can_manage_field_trips = true
              OR public.ft_is_manager(field_trip_payments.field_trip_id, p.id)
            )
          )
        )
    )
  );

-- INSERT: same set — trip manager or admin.
CREATE POLICY ftp_insert ON public.field_trip_payments
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_payments.field_trip_id)
            AND (
              p.can_manage_field_trips = true
              OR public.ft_is_manager(field_trip_payments.field_trip_id, p.id)
            )
          )
        )
    )
  );

-- UPDATE: same.
CREATE POLICY ftp_update ON public.field_trip_payments
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_payments.field_trip_id)
            AND (
              p.can_manage_field_trips = true
              OR public.ft_is_manager(field_trip_payments.field_trip_id, p.id)
            )
          )
        )
    )
  );

-- DELETE: same.
CREATE POLICY ftp_delete ON public.field_trip_payments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(field_trip_payments.field_trip_id)
            AND (
              p.can_manage_field_trips = true
              OR public.ft_is_manager(field_trip_payments.field_trip_id, p.id)
            )
          )
        )
    )
  );


-- ── 3. field_trip_payment_log ─────────────────────────────────────────
-- Append-only audit trail. Each time a teacher records money received,
-- one row is added here and field_trip_payments.amount_paid is updated
-- by the application.

CREATE TABLE IF NOT EXISTS public.field_trip_payment_log (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  payment_id    uuid        NOT NULL REFERENCES public.field_trip_payments(id) ON DELETE CASCADE,
  amount        numeric(8,2) NOT NULL CHECK (amount > 0),
  received_date date        NOT NULL DEFAULT CURRENT_DATE,
  notes         text,
  recorded_by   uuid        REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT field_trip_payment_log_pkey PRIMARY KEY (id)
);

ALTER TABLE public.field_trip_payment_log ENABLE ROW LEVEL SECURITY;

-- SELECT: join through field_trip_payments to get the trip_id,
-- then apply the same manager/admin check.
CREATE POLICY ftpl_select ON public.field_trip_payment_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.field_trip_payments ftp
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE ftp.id = field_trip_payment_log.payment_id
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(ftp.field_trip_id)
            AND (
              p.can_manage_field_trips = true
              OR public.ft_is_manager(ftp.field_trip_id, p.id)
            )
          )
        )
    )
  );

-- INSERT: same join check.
CREATE POLICY ftpl_insert ON public.field_trip_payment_log
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.field_trip_payments ftp
      JOIN public.profiles p ON p.user_id = auth.uid()
      WHERE ftp.id = field_trip_payment_log.payment_id
        AND (
          p.is_superadmin = true
          OR (
            p.school_id = public.ft_get_school_id(ftp.field_trip_id)
            AND (
              p.can_manage_field_trips = true
              OR public.ft_is_manager(ftp.field_trip_id, p.id)
            )
          )
        )
    )
  );

-- Payment log rows are never updated or deleted (append-only ledger).
-- If a payment was entered in error, the teacher adds a correcting
-- negative-style note and adjusts amount_paid on the summary row.
