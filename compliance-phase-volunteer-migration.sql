-- Phase: Volunteer management additions
-- Run this after compliance-phase-bc-migration.sql
--
-- Adds:
--   compliance_bg_check_requests: volunteer_roles[], mvr_cleared_at, mvr_expires_at
--   guardians: dl_expires_at, insurance_expires_at, can_chaperone, can_drive

ALTER TABLE compliance_bg_check_requests
  ADD COLUMN IF NOT EXISTS volunteer_roles  text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mvr_cleared_at   date,
  ADD COLUMN IF NOT EXISTS mvr_expires_at   date;

ALTER TABLE guardians
  ADD COLUMN IF NOT EXISTS dl_expires_at        date,
  ADD COLUMN IF NOT EXISTS insurance_expires_at date,
  ADD COLUMN IF NOT EXISTS can_chaperone         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_drive             boolean NOT NULL DEFAULT true;
