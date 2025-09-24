const express = require('express');
const path = require('path');

function normalizeRelativePath(relativePath) {
  if (!relativePath) {
    return null;
  }
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..')) {
    return null;
  }
  return normalized.split(path.sep).join('/');
}

function buildRouter({ database, recordingRoot }) {
  const router = express.Router();

  router.get('/sessions', (req, res) => {
    try {
      const sessions = database.getSessions().map((session) => ({
        id: session.id,
        guildName: session.guildName,
        channelName: session.channelName,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        participantCount: session.participantCount ?? 0,
        hasAudio: Boolean(session.audioPath),
      }));
      res.json({ sessions });
    } catch (error) {
      console.error('Failed to list sessions:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  router.get('/sessions/:sessionId', (req, res) => {
    try {
      const detail = database.getSessionDetail(req.params.sessionId);
      if (!detail) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const { session, participants, segments } = detail;
      const mixdownPublicPath = normalizeRelativePath(session.audioPath);
      const fullAudioUrl = mixdownPublicPath ? `/recordings/${mixdownPublicPath}` : null;
      const responseSegments = segments.map((segment) => {
        const publicPath = normalizeRelativePath(segment.audioPath);
        return {
          id: segment.id,
          userId: segment.userId,
          label: segment.label,
          startedAt: segment.startedAt,
          text: segment.text,
          audioUrl: publicPath ? `/recordings/${publicPath}` : null,
        };
      });

      res.json({
        session: {
          ...session,
          audioUrl: fullAudioUrl,
        },
        participants,
        segments: responseSegments,
      });
    } catch (error) {
      console.error('Failed to get session detail:', error);
      res.status(500).json({ error: 'Failed to get session detail' });
    }
  });

  return router;
}

function startHttpServer({ database, recordingRoot, webRoot, port }) {
  if (!database) {
    throw new Error('Database instance is required to start HTTP server');
  }

  const resolvedWebRoot = webRoot ? path.resolve(webRoot) : path.resolve(__dirname, 'web');
  const resolvedRecordingRoot = recordingRoot ? path.resolve(recordingRoot) : null;

  const app = express();

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', buildRouter({ database, recordingRoot: resolvedRecordingRoot }));

  if (resolvedRecordingRoot) {
    app.use('/recordings', express.static(resolvedRecordingRoot));
  }

  app.use(express.static(resolvedWebRoot));

  const finalPort = port ?? Number(process.env.PORT ?? 16384);
  const server = app.listen(finalPort, () => {
    console.log(`HTTP server listening on port ${finalPort}`);
  });

  return { app, server };
}

module.exports = { startHttpServer };
