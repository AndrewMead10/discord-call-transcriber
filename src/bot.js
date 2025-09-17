const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const { AudioCaptureManager } = require('./recording/audioCapture');
const { TranscriptionClient } = require('./transcription/transcriptionClient');

class CallTranscribeBot {
  constructor({ token, recordingRoot, transcriptionConfig }) {
    this.token = token;
    this.recordingRoot = recordingRoot;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.captureManager = new AudioCaptureManager({ baseDir: this.recordingRoot });
    this.transcriptionClient = new TranscriptionClient(transcriptionConfig);
    this.connections = new Map();

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
      await this.captureManager.start(connection, message.guild.id);
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

    connection.destroy();
    this.connections.delete(message.guild.id);

    const manifest = await this.captureManager.stop(message.guild.id);
    if (!manifest) {
      await message.reply('Stopped listening, but there was nothing recorded.');
      return;
    }

    const transcriptionResult = await this.transcriptionClient.submit(manifest);

    if (transcriptionResult.status === 'sent') {
      await message.reply('Recording stopped. I sent the audio manifest to the transcription service.');
    } else if (transcriptionResult.status === 'skipped') {
      await message.reply('Recording stopped. Configure the transcription endpoint to process the audio.');
    } else if (transcriptionResult.status === 'failed') {
      await message.reply(`Recording stopped, but I could not reach the transcription service: ${transcriptionResult.reason}`);
    }
  }
}

module.exports = { CallTranscribeBot };
