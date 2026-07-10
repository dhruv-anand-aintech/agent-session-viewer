create table if not exists users (
  id text primary key,
  email text not null,
  name text,
  picture text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table if not exists machines (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  label text not null,
  token_hash text not null unique,
  created_at text not null default (datetime('now')),
  last_seen_at text,
  revoked_at text
);

create index if not exists machines_user_idx on machines(user_id, revoked_at);

create table if not exists machine_pairings (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  label text not null,
  code_hash text not null unique,
  created_at text not null default (datetime('now')),
  expires_at text not null,
  claimed_at text
);

create index if not exists machine_pairings_pending_idx
  on machine_pairings(code_hash, claimed_at, expires_at);

create table if not exists command_queue (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  machine_id text not null references machines(id) on delete cascade,
  type text not null,
  payload text not null,
  created_at text not null default (datetime('now')),
  delivered_at text,
  completed_at text
);

create index if not exists command_queue_machine_pending_idx
  on command_queue(machine_id, delivered_at, created_at);
