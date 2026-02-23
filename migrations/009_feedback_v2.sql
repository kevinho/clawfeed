-- Add category and read_at to feedback table (PRD v0.2)
ALTER TABLE feedback ADD COLUMN category TEXT;
ALTER TABLE feedback ADD COLUMN read_at TEXT;
