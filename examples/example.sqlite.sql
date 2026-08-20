-- Example schema for a quick start with dsh-db-connector (SQLite).
-- Create the file, then: db_connect app (driver sqlite, database ./data/app.db),
-- run this via db_exec once, then query freely.

CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  display    TEXT,
  age        INTEGER CHECK (age >= 0),
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  body       TEXT,
  published  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_posts_author ON posts (author_id);
CREATE INDEX idx_posts_published ON posts (published);

INSERT INTO users (email, display, age, is_admin) VALUES
  ('ada@example.org', 'Ada', 36, 1),
  ('grace@example.org', 'Grace', 45, 1),
  ('linus@example.org', 'Linus', 54, 1),
  ('margaret@example.org', 'Margaret', 28, 0);

INSERT INTO posts (author_id, title, body, published) VALUES
  (1, 'Hello, database connectors', 'Read-only by default. Writes need approval.', 1),
  (2, 'On compilers and correctness', 'Parameter binding beats string interpolation.', 1),
  (3, 'Notes from the kernel', 'Never log credentials.', 0);
