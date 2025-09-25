require('dotenv').config();
const path = require('path');
const { CallTranscribeBot } = require('./bot');
const { createDatabase } = require('./db');
const { startHttpServer } = require('./server/httpServer');

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('Set DISCORD_TOKEN in your environment before starting the bot.');
  process.exit(1);
}

const recordingRoot = path.resolve(__dirname, '..', 'tmp');
const webRoot = path.resolve(__dirname, 'server', 'web');
const database = createDatabase(process.env.DATABASE_PATH);

const summaryConfig = {
  baseUrl: process.env.LLM_BASE_URL || 'https://llm-server.amqm.dev/v1',
  apiKey: process.env.LLM_API_KEY || 'theres-your-api-key',
};

const port = Number(process.env.PORT || 16384);

const http = startHttpServer({
  database,
  recordingRoot,
  webRoot,
  port,
});

const bot = new CallTranscribeBot({
  token,
  recordingRoot,
  transcriptionConfig: {
    url: process.env.TRANSCRIPTION_URL,
    apiKey: process.env.TRANSCRIPTION_API_KEY,
    headerName: process.env.TRANSCRIPTION_HEADER_NAME,
  },
  summaryConfig,
  database,
});

bot
  .login()
  .then(() => console.log('Bot is running.'))
  .catch((error) => {
    console.error('Failed to login:', error);
    http.server.close();
    process.exit(1);
  });

const shutdown = () => {
  console.log('Shutting down...');
  http.server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
