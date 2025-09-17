const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream');
const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');

class AudioCaptureSession {
  constructor({ connection, guildId, baseDir }) {
    this.connection = connection;
    this.guildId = guildId;
    this.baseDir = baseDir;
    this.recordings = new Map();
    this.cleanups = [];
    this.sessionId = `${Date.now()}`;
    this.sessionDir = path.join(this.baseDir, this.guildId, this.sessionId);
  }

  async init() {
    await fsp.mkdir(this.sessionDir, { recursive: true });
    this._wireSpeakingEvents();
  }

  _wireSpeakingEvents() {
    const receiver = this.connection.receiver;

    const speakingStart = async (userId) => {
      try {
        const userDir = path.join(this.sessionDir, userId);
        await fsp.mkdir(userDir, { recursive: true });

        const opusStream = receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000,
          },
        });

        const pcmStream = new prism.opus.Decoder({
          frameSize: 960,
          channels: 2,
          rate: 48000,
        });

        const filename = `${Date.now()}.pcm`;
        const filePath = path.join(userDir, filename);
        const fileStream = fs.createWriteStream(filePath);

        pipeline(opusStream, pcmStream, fileStream, (error) => {
          if (error) {
            console.error(`Audio pipeline error for ${userId}:`, error);
          }
        });

        const recordings = this.recordings.get(userId) ?? [];
        recordings.push(filePath);
        this.recordings.set(userId, recordings);

        this.cleanups.push(() => {
          if (!fileStream.closed) {
            fileStream.end();
          }
        });
      } catch (error) {
        console.error(`Failed to start capture for ${userId}:`, error);
      }
    };

    receiver.speaking.on('start', speakingStart);

    this.cleanups.push(() => receiver.speaking.off('start', speakingStart));
  }

  getManifest() {
    return {
      guildId: this.guildId,
      sessionId: this.sessionId,
      directory: this.sessionDir,
      recordings: Object.fromEntries(this.recordings),
    };
  }

  async destroy() {
    while (this.cleanups.length) {
      const disposer = this.cleanups.pop();
      try {
        disposer();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }
  }
}

class AudioCaptureManager {
  constructor({ baseDir }) {
    this.baseDir = baseDir;
    this.sessions = new Map();
  }

  async start(connection, guildId) {
    if (this.sessions.has(guildId)) {
      return this.sessions.get(guildId);
    }

    const session = new AudioCaptureSession({ connection, guildId, baseDir: this.baseDir });
    await session.init();
    this.sessions.set(guildId, session);
    return session;
  }

  async stop(guildId) {
    const session = this.sessions.get(guildId);
    if (!session) {
      return null;
    }
    await session.destroy();
    this.sessions.delete(guildId);
    return session.getManifest();
  }

  get(guildId) {
    return this.sessions.get(guildId) ?? null;
  }
}

module.exports = { AudioCaptureManager };
