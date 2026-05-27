-- SQL Migration: Add deleted_at column for Soft Delete support
-- Execute this script in your Supabase SQL Editor (https://supabase.com)

ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Performance index for active customers (excluding soft-deleted ones)
CREATE INDEX IF NOT EXISTS idx_customers_deleted_at ON customers(deleted_at) WHERE deleted_at IS NULL;
