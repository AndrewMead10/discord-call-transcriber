const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const path = require('path');
const { AudioCaptureManager } = require('./recording/audioCapture');
const { mixSessionAudio } = require('./recording/mixdown');
const { TranscriptionClient } = require('./transcription/transcriptionClient');
const { SummaryClient } = require('./summary/summaryClient');

function chunkText(text, maxLength) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line).length + 1 > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      if (line.length > maxLength) {
        let start = 0;
        while (start < line.length) {
          chunks.push(line.slice(start, start + maxLength));
          start += maxLength;
        }
        continue;
      }
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

class CallTranscribeBot {
  constructor({ token, recordingRoot, transcriptionConfig, summaryConfig, database }) {
    this.token = token;
    this.recordingRoot = recordingRoot;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.captureManager = new AudioCaptureManager({ baseDir: this.recordingRoot });
    this.transcriptionClient = new TranscriptionClient(transcriptionConfig);
    this.summaryClient = new SummaryClient(summaryConfig);
    this.connections = new Map();
    this.sessionMetadata = new Map();
    this.database = database ?? null;

    this._registerEventHandlers();
  }

  async login() {
    return this.client.login(this.token);
  }

  _registerEventHandlers() {
    this.client.once(Events.ClientReady, (client) => {
      console.log(`Logged in as ${client.user.tag}`);
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) {
        return;
      }
      if (!message.guild) {
        return;
      }
      if (!message.mentions.has(this.client.user, { ignoreEveryone: true, ignoreRepliedUser: true })) {
        return;
      }

      const lowered = message.content.toLowerCase();
      if (lowered.includes('leave') || lowered.includes('stop') || lowered.includes('done')) {
        await this._handleStopRequest(message);
      } else {
        await this._handleJoinRequest(message);
      }
    });
  }

  async _handleJoinRequest(message) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      await message.reply('Join a voice channel before mentioning me so I know where to go.');
      return;
    }

    const existingConnection = this.connections.get(message.guild.id);
    if (existingConnection) {
      await message.reply('I am already connected and recording. Mention me with "leave" when you want me to stop.');
      return;
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.connections.set(message.guild.id, connection);

      const participants = Array.from(voiceChannel.members.values()).map((member) => ({
        userId: member.id,
        displayName: member.displayName ?? member.user?.username ?? member.user?.tag ?? member.id,
        joinedAt: Date.now(),
      }));

      this.sessionMetadata.set(message.guild.id, {
        guildId: message.guild.id,
        guildName: message.guild.name,
        channelId: voiceChannel.id,
        channelName: voiceChannel.name,
        startedAt: Date.now(),
        participants,
      });

      const resolveLabel = (userId) => {
        const member = message.guild.members.cache.get(userId);
        if (member) {
          return member.displayName;
        }
        const user = this.client.users.cache.get(userId);
        return user ? user.tag : userId;
      };

      await this.captureManager.start(connection, message.guild.id, { resolveLabel });
      await message.reply(`Joined ${voiceChannel.name} and started recording. Mention me with "leave" when you want me to stop.`);

      connection.on('error', (error) => {
        console.error('Voice connection error:', error);
      });

      const teardown = async (label) => {
        console.log(`Voice connection ${label} in guild ${message.guild.id}`);
        await this.captureManager.stop(message.guild.id);
        this.connections.delete(message.guild.id);
      };

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        teardown('disconnected').catch((error) => {
          console.error('Disconnect teardown failed:', error);
        });
      });
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        teardown('destroyed').catch((error) => {
          console.error('Destroy teardown failed:', error);
        });
      });
    } catch (error) {
      console.error('Failed to join voice channel:', error);
      await message.reply('I could not join the voice channel. Check my permissions and try again.');
    }
  }

  async _handleStopRequest(message) {
    const connection = this.connections.get(message.guild.id) ?? getVoiceConnection(message.guild.id);
    if (!connection) {
      await message.reply('I am not in a voice channel right now.');
      return;
    }

    const channelId = connection.joinConfig?.channelId ?? null;
    const metadata = this.sessionMetadata.get(message.guild.id);

    connection.destroy();
    this.connections.delete(message.guild.id);

    const manifest = await this.captureManager.stop(message.guild.id);
    if (!manifest) {
      await message.reply('Stopped listening, but there was nothing recorded.');
      return;
    }

    const mixdownPath = await mixSessionAudio({ manifest });

    const transcriptionResult = await this.transcriptionClient.submit(manifest);

    let summaryResult = { status: 'skipped', reason: 'Transcription not completed' };
    if (transcriptionResult.status === 'sent') {
      summaryResult = await this._summarizeTranscription({
        transcriptionResult,
        metadata,
        manifest,
      });

      if (summaryResult.status === 'summarized' && transcriptionResult.data) {
        transcriptionResult.data.summary = summaryResult.summary;
      }
    }

    await this._persistSession({
      message,
      manifest,
      transcriptionResult,
      metadata,
      channelId,
      mixdownPath,
    });

    this.sessionMetadata.delete(message.guild.id);

    if (transcriptionResult.status === 'sent') {
      const transcript = transcriptionResult.data?.transcript;
      if (transcript) {
        const sessionId = manifest.sessionId;
        const baseUrl = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 16384}`).replace(/\/$/, '');
        const shareUrl = `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;

        await message.reply('Recording stopped. View the transcription here:');
        await message.channel.send(shareUrl);

        if (summaryResult.status === 'summarized') {
          const summaryChunks = chunkText(summaryResult.summary, 1800);
          if (summaryChunks.length) {
            await message.channel.send('Summary of the call:');
            for (const chunk of summaryChunks) {
              await message.channel.send(chunk);
            }
          }
        } else if (summaryResult.status === 'failed') {
          await message.channel.send(`Recording summary failed: ${summaryResult.reason}`);
        }
      } else {
        await message.reply('Recording stopped. Transcription service responded without content.');
      }
    } else if (transcriptionResult.status === 'skipped') {
      await message.reply('Recording stopped. Configure the transcription endpoint to process the audio.');
    } else if (transcriptionResult.status === 'failed') {
      await message.reply(`Recording stopped, but I could not reach the transcription service: ${transcriptionResult.reason}`);
    }
  }

  async _summarizeTranscription({ transcriptionResult, metadata, manifest }) {
    if (!this.summaryClient || !this.summaryClient.isConfigured()) {
      return { status: 'skipped', reason: 'Summarization service is not configured' };
    }

    const transcript = transcriptionResult?.data?.transcript;
    if (!transcript || !transcript.trim()) {
      return { status: 'skipped', reason: 'Transcript was empty' };
    }

    const segments = Array.isArray(transcriptionResult?.data?.segments)
      ? transcriptionResult.data.segments
      : [];

    const participantsByKey = new Map();
    const registerParticipant = (userId, displayName) => {
      if (!userId && !displayName) {
        return;
      }
      const key = userId || displayName;
      const existing = participantsByKey.get(key);
      if (existing) {
        if (!existing.displayName && displayName) {
          existing.displayName = displayName;
        }
        if (!existing.userId && userId) {
          existing.userId = userId;
        }
        return;
      }
      participantsByKey.set(key, {
        userId: userId || null,
        displayName: displayName || userId || 'Unknown participant',
      });
    };

    if (Array.isArray(metadata?.participants)) {
      for (const participant of metadata.participants) {
        registerParticipant(participant?.userId ?? null, participant?.displayName ?? null);
      }
    }

    const labels = manifest?.labels ?? {};
    for (const [userId, label] of Object.entries(labels)) {
      registerParticipant(userId, label);
    }

    for (const segment of segments) {
      registerParticipant(segment?.userId ?? null, segment?.label ?? null);
    }

    const sessionMetadata = {
      guildName: metadata?.guildName ?? null,
      channelName: metadata?.channelName ?? null,
      startedAt: metadata?.startedAt ?? manifest?.startedAt ?? null,
      participants: Array.from(participantsByKey.values()),
    };

    return this.summaryClient.summarize({
      transcript,
      segments,
      sessionMetadata,
    });
  }

  async _collectParticipants({ message, metadata, channelId, manifest }) {
    const participantsById = new Map();
    const sessionId = manifest.sessionId;
    let resolvedChannelId = metadata?.channelId ?? channelId ?? null;
    let resolvedChannelName = metadata?.channelName ?? null;

    const addParticipant = (userId, displayName, joinedAt = null) => {
      if (!userId) {
        return;
      }
      const existing = participantsById.get(userId);
      if (existing) {
        if (!existing.displayName && displayName) {
          existing.displayName = displayName;
        }
        if (!existing.joinedAt && joinedAt) {
          existing.joinedAt = joinedAt;
        }
        return;
      }
      participantsById.set(userId, {
        sessionId,
        userId,
        displayName: displayName || userId,
        joinedAt: joinedAt ?? null,
      });
    };

    if (metadata?.participants?.length) {
      for (const participant of metadata.participants) {
        addParticipant(participant.userId, participant.displayName, participant.joinedAt);
      }
    }

    let voiceChannel = null;
    if (channelId) {
      voiceChannel = message.guild.channels.cache.get(channelId) ?? null;
      if (!voiceChannel) {
        try {
          voiceChannel = await message.guild.channels.fetch(channelId);
        } catch (error) {
          voiceChannel = null;
        }
      }
    }

    if (voiceChannel && voiceChannel.isVoiceBased()) {
      resolvedChannelId = voiceChannel.id;
      resolvedChannelName = voiceChannel.name;
      for (const member of voiceChannel.members.values()) {
        const displayName = member.displayName ?? member.user?.username ?? member.user?.tag ?? member.id;
        addParticipant(member.id, displayName, metadata?.startedAt ?? null);
      }
    }

    const labels = manifest.labels ?? {};
    for (const [userId, label] of Object.entries(labels)) {
      addParticipant(userId, label, metadata?.startedAt ?? null);
    }

    return {
      participants: Array.from(participantsById.values()),
      channelId: resolvedChannelId,
      channelName: resolvedChannelName,
    };
  }

  async _persistSession({ message, manifest, transcriptionResult, metadata, channelId, mixdownPath }) {
    if (!this.database) {
      return;
    }

    try {
      const data = await this._collectParticipants({
        message,
        metadata,
        channelId,
        manifest,
      });

      const now = Date.now();
      const sessionId = manifest.sessionId;
      const manifestTimestamp = Number.parseInt(sessionId, 10);
      const sessionStartedAt = metadata?.startedAt
        ?? (Number.isFinite(manifestTimestamp) ? manifestTimestamp : now);
      const transcript = transcriptionResult.data?.transcript ?? null;
      const summary = transcriptionResult.data?.summary ?? null;
      const segmentsFromResult = transcriptionResult.data?.segments ?? [];

      const participants = data.participants.map((participant) => ({
        ...participant,
        joinedAt: participant.joinedAt ?? sessionStartedAt,
      }));

      const segments = segmentsFromResult.map((segment) => ({
        id: segment.id,
        sessionId,
        userId: segment.userId ?? null,
        label: segment.label ?? null,
        startedAt: segment.startedAt ?? null,
        text: segment.text ?? '',
        audioPath: segment.audioPath
          ? path.relative(this.recordingRoot, segment.audioPath)
          : null,
      }));

      const mixdownRelativePath = mixdownPath
        ? path.relative(this.recordingRoot, mixdownPath)
        : null;

      const sessionRecord = {
        id: sessionId,
        guildId: metadata?.guildId ?? message.guild.id,
        guildName: metadata?.guildName ?? message.guild.name,
        channelId: data.channelId ?? metadata?.channelId ?? channelId ?? null,
        channelName: data.channelName ?? metadata?.channelName ?? null,
        startedAt: sessionStartedAt,
        endedAt: now,
        transcript,
        summary,
        audioPath: mixdownRelativePath,
      };

      this.database.saveSession({
        session: sessionRecord,
        participants,
        segments,
      });
    } catch (error) {
      console.error('Failed to persist session data:', error);
    }
  }
}

module.exports = { CallTranscribeBot };
