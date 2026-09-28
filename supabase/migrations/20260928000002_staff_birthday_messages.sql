-- ============================================================
-- Staff birthday messages ("Birthday Notes"): a short, in-app-only note a
-- staff member can leave for a colleague whose birthday is coming up.
-- Deliberately not routed through email/send_*_notification -- the whole
-- point is one more lightweight, low-stakes channel that doesn't add to
-- anyone's inbox. Sending is gated client-side to the same daysLeft <= 2
-- window the Upcoming Birthdays card already uses (covers a Friday note for
-- a Sunday birthday). birthday_year plus the unique constraint below caps
-- it at one note per sender per recipient per birthday cycle.
--
-- Rows are kept permanently (this is what backs the staff "My Birthday
-- Notes" history view) -- the live Birthday Notes panel just filters by
-- date client-side to a rolling few-day window rather than the table being
-- pruned.
-- ============================================================

CREATE TABLE public.staff_birthday_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    recipient_employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    sender_employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    message text NOT NULL,
    birthday_year integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_birthday_messages_pkey PRIMARY KEY (id),
    CONSTRAINT staff_birthday_messages_not_self CHECK (sender_employee_id <> recipient_employee_id),
    CONSTRAINT staff_birthday_messages_length CHECK (char_length(btrim(message)) > 0 AND char_length(message) <= 280),
    CONSTRAINT staff_birthday_messages_one_per_year UNIQUE (recipient_employee_id, sender_employee_id, birthday_year)
);

CREATE INDEX idx_staff_birthday_messages_school    ON public.staff_birthday_messages USING btree (school_id);
CREATE INDEX idx_staff_birthday_messages_recipient ON public.staff_birthday_messages USING btree (recipient_employee_id);

ALTER TABLE public.staff_birthday_messages ENABLE ROW LEVEL SECURITY;

-- No anon policy exists below, so no anon grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_birthday_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_birthday_messages TO service_role;

-- School-wide read: the live panel is meant to be seen by everyone, and this
-- also covers a sender viewing their own sent note and a recipient viewing
-- their own history.
CREATE POLICY "Birthday messages: read own school" ON public.staff_birthday_messages FOR SELECT USING (
    school_id = ( SELECT p.school_id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1 )
);

CREATE POLICY "Birthday messages: staff insert own" ON public.staff_birthday_messages FOR INSERT WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND p.employee_id = staff_birthday_messages.sender_employee_id
          AND p.school_id = staff_birthday_messages.school_id
    )
);
