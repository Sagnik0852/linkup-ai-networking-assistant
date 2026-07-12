-- ============================================================
-- LinkUp database schema · run this once in Supabase SQL Editor
-- ============================================================

-- A fixed list of pipeline stages a contact can be in.
-- Using a fixed list (enum) prevents typos like "acepted".
create type contact_status as enum
  ('request_sent',    -- you sent a connection request
   'accepted',        -- they accepted, first message not sent yet
   'messaged',        -- you sent the first message, waiting for reply
   'in_conversation', -- actively talking
   'dormant',         -- gone quiet for a long time
   'closed');         -- consciously done (got the referral / not relevant)

-- ============ TABLE 1: one row per person ============
create table contacts (
  id                uuid primary key default gen_random_uuid(), -- auto ID
  linkedin_url      text unique not null,  -- UNIQUE: same person can never appear twice
  full_name         text not null,
  headline          text,                  -- their LinkedIn tagline
  company           text,                  -- current company
  role              text,
  previous_companies text[],               -- a list, e.g. {'Amazon','Flipkart'}
  college           text,
  location          text,
  is_bits_alum      boolean default false, -- BITS Pilani = your strongest hook
  connection_date   date,
  first_message     text,                  -- the AI first message you sent
  status            contact_status default 'accepted',
  relationship_strength smallint check (relationship_strength between 1 and 5),
  referral_potential    smallint check (referral_potential between 1 and 5),
  hiring_status     text,                  -- 'hiring_now' | 'hiring_later' | 'unknown'
  hiring_notes      text,                  -- e.g. "team hiring interns in Aug"
  last_contacted    date,
  next_follow_up    date,                  -- the morning robot reads this
  tags              text[],
  important_notes   text,                  -- your own manual notes
  ai_notes          text,
  conversation_summary text,               -- rolling summary of where things stand
  raw_profile_text  text,                  -- exactly what the extension captured
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ============ TABLE 2: every capture, kept forever ============
create table interactions (
  id             uuid primary key default gen_random_uuid(),
  contact_id     uuid references contacts(id) on delete cascade, -- links to the person
  captured_at    timestamptz default now(),
  direction      text,          -- 'capture' or 'draft_generated'
  raw_text       text not null, -- the full conversation text (never deleted)
  summary        text,
  key_points     jsonb,         -- {advice:[], referrals:[], hiring:[], promises:[], action_items:[]}
  sentiment      text           -- 'warm' | 'neutral' | 'cold'
);

-- ============ TABLE 3: follow-up drafts from the morning robot ============
create table follow_ups (
  id             uuid primary key default gen_random_uuid(),
  contact_id     uuid references contacts(id) on delete cascade,
  due_date       date not null,
  reason         text not null,           -- why the robot flagged this person
  draft          text,                    -- the AI-drafted message
  status         text default 'pending',  -- 'pending' | 'sent' | 'dismissed'
  created_at     timestamptz default now()
);

-- Indexes = speed. These make the daily queries instant.
create index on contacts (next_follow_up) where status not in ('closed','dormant');
create index on contacts (company);
create index on interactions (contact_id, captured_at desc);
