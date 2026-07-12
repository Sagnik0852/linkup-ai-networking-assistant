-- ============================================================
-- LinkUp v2 · learning-loop schema
-- ============================================================

-- Your master style guide lives HERE (not in code).
-- Edit it any time in the Table Editor; next draft uses the new version.
create table prompt_config (
  id          int primary key default 1 check (id = 1),  -- singleton row
  content     text not null,
  updated_at  timestamptz default now()
);

-- Every draft ever produced: what went in, what came out, what happened.
create table message_examples (
  id               uuid primary key default gen_random_uuid(),
  contact_id       uuid references contacts(id) on delete cascade,
  captured_at      timestamptz default now(),
  message_type     text not null default 'cold_outreach',
                   -- 'cold_outreach' | 'reply' | 'follow_up' | ...
  classification   jsonb,          -- §8 output: tier, side, track, flags
  profile_snippet  text,           -- the hook material that drove the draft
  input_context    text,           -- for replies: prior thread excerpt
  draft_original   text not null,  -- what Claude produced
  draft_sent       text,           -- what Sagnik actually sent
  outcome          text,           -- 'used_as_is' | 'edited_minor' | 'edited_heavy'
                                   -- | 'discarded' | 'callout_ai'
                                   -- | 'got_reply_positive' | 'got_reply_negative'
                                   -- | 'referral_given' | null (= awaiting feedback)
  edit_distance    int,
  callout_reason   text,
  quality_score    real default 0.5   -- 0.0–1.0; retrieval prefers high scores
);
create index on message_examples (message_type, quality_score desc);
create index on message_examples (outcome);
create index on message_examples (contact_id, captured_at desc);

-- The evolving voice profile: things the system LEARNS about how Sagnik writes.
create table voice_profile (
  id                     int primary key default 1 check (id = 1),
  updated_at             timestamptz default now(),
  learned_bans           text[]  default '{}',  -- promoted: removed in 3+ edits
  ban_candidates         jsonb   default '{}',  -- {phrase: times_removed}
  learned_preferences    jsonb   default '{}',  -- {generic_phrase: preferred_alt}
  recent_hook_openers    text[]  default '{}',  -- last 20 opening lines (anti-repetition)
  recent_closer_variants text[]  default '{}',
  total_drafts           int default 0,
  drafts_used_as_is      int default 0,
  drafts_edited          int default 0,
  drafts_callouts        int default 0
);
insert into voice_profile (id) values (1);   -- seed the singleton
