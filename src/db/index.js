const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.resolve(__dirname, '..', '..', 'data', 'transcripts.db');

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function createDatabase(dbPath = process.env.DATABASE_PATH) {
  const resolvedPath = dbPath ? path.resolve(dbPath) : DEFAULT_DB_PATH;
  ensureDirectory(resolvedPath);

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      guild_name TEXT,
      channel_id TEXT,
      channel_name TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      transcript TEXT,
      audio_path TEXT
    );

    CREATE TABLE IF NOT EXISTS session_participants (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT,
      joined_at INTEGER,
      PRIMARY KEY (session_id, user_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      label TEXT,
      started_at INTEGER,
      text TEXT,
      audio_path TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  try {
    db.prepare('ALTER TABLE sessions ADD COLUMN audio_path TEXT').run();
  } catch (error) {
    if (!/duplicate column name/i.test(error.message)) {
      throw error;
    }
  }

  const insertSessionStmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      id, guild_id, guild_name, channel_id, channel_name, started_at, ended_at, transcript, audio_path
    ) VALUES (@id, @guildId, @guildName, @channelId, @channelName, @startedAt, @endedAt, @transcript, @audioPath)
  `);

  const insertParticipantStmt = db.prepare(`
    INSERT OR REPLACE INTO session_participants (
      session_id, user_id, display_name, joined_at
    ) VALUES (@sessionId, @userId, @displayName, @joinedAt)
  `);

  const insertSegmentStmt = db.prepare(`
    INSERT OR REPLACE INTO segments (
      id, session_id, user_id, label, started_at, text, audio_path
    ) VALUES (@id, @sessionId, @userId, @label, @startedAt, @text, @audioPath)
  `);

  const deleteSegmentsStmt = db.prepare('DELETE FROM segments WHERE session_id = ?');
  const deleteParticipantsStmt = db.prepare('DELETE FROM session_participants WHERE session_id = ?');
  const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');

  const saveSession = db.transaction(({ session, participants, segments }) => {
    insertSessionStmt.run(session);

    deleteParticipantsStmt.run(session.id);
    for (const participant of participants) {
      insertParticipantStmt.run(participant);
    }

    deleteSegmentsStmt.run(session.id);
    for (const segment of segments) {
      insertSegmentStmt.run(segment);
    }
  });

  const listSessionsStmt = db.prepare(`
    SELECT s.id,
           s.guild_name AS guildName,
           s.channel_name AS channelName,
           s.started_at AS startedAt,
           s.ended_at AS endedAt,
           s.audio_path AS audioPath,
           COUNT(p.user_id) AS participantCount
    FROM sessions s
    LEFT JOIN session_participants p ON p.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
  `);

  const getSessionStmt = db.prepare(`
    SELECT id, guild_id AS guildId, guild_name AS guildName, channel_id AS channelId,
           channel_name AS channelName, started_at AS startedAt, ended_at AS endedAt,
           transcript, audio_path AS audioPath
    FROM sessions
    WHERE id = ?
  `);

  const listParticipantsStmt = db.prepare(`
    SELECT user_id AS userId, display_name AS displayName, joined_at AS joinedAt
    FROM session_participants
    WHERE session_id = ?
    ORDER BY display_name COLLATE NOCASE
  `);

  const listSegmentsStmt = db.prepare(`
    SELECT id, user_id AS userId, label, started_at AS startedAt, text, audio_path AS audioPath
    FROM segments
    WHERE session_id = ?
    ORDER BY started_at ASC
  `);

  return {
    saveSession(payload) {
      saveSession(payload);
    },
    getSessions() {
      return listSessionsStmt.all();
    },
    getSessionDetail(sessionId) {
      const session = getSessionStmt.get(sessionId);
      if (!session) {
        return null;
      }
      const participants = listParticipantsStmt.all(sessionId);
      const segments = listSegmentsStmt.all(sessionId);
      return { session, participants, segments };
    },
    deleteSession(sessionId) {
      const session = getSessionStmt.get(sessionId);
      if (!session) {
        return false;
      }

      const result = deleteSessionStmt.run(sessionId);
      return result.changes > 0;
    },
  };
}

module.exports = { createDatabase };
