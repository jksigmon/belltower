-- Migration: Add contact/location columns to public.schools
-- Date: 2026-05-22

ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS phone    text,
  ADD COLUMN IF NOT EXISTS address  text,
  ADD COLUMN IF NOT EXISTS city     text,
  ADD COLUMN IF NOT EXISTS state    text,
  ADD COLUMN IF NOT EXISTS zip      text,
  ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'America/New_York';
