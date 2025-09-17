require('dotenv').config();
const path = require('path');
const { CallTranscribeBot } = require('./bot');

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('Set DISCORD_TOKEN in your environment before starting the bot.');
  process.exit(1);
}

const bot = new CallTranscribeBot({
  token,
  recordingRoot: path.resolve(__dirname, '..', 'tmp'),
  transcriptionConfig: {
    url: process.env.TRANSCRIPTION_URL,
    apiKey: process.env.TRANSCRIPTION_API_KEY,
  },
});

bot
  .login()
  .then(() => console.log('Bot is running.'))
  .catch((error) => {
    console.error('Failed to login:', error);
    process.exit(1);
  });
