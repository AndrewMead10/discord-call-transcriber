# Call Transcribe Bot

Discord bot that joins the voice channel of the user who mentions it, records each participant's audio into individual PCM files, and forwards a manifest to a transcription service for further processing.

## Requirements

- Node.js 22.12 or newer
- Discord application with a bot token
- The following gateway intents enabled for the bot: **Message Content**, **Server Members**, and **Presence** (Message Content is required to detect mentions).
- FFmpeg is **not** required because recording happens through PCM decoding only.

## Installation

```bash
npm install
```

If you manage Node versions manually, ensure the runtime is at least `22.12.0` (the bot defines this in `package.json"engines"`).

If the install command fails due to network restrictions, ensure the dependencies listed in `package.json` are downloaded manually: `discord.js`, `@discordjs/voice`, `prism-media`, and `dotenv`.

## Configuration

Copy the sample environment file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Discord developer portal. |
| `GUILD_ID` | (Optional) Restrict the bot to a single guild. Not currently used in code but reserved for future filtering. |
| `TRANSCRIPTION_URL` | HTTPS endpoint that will receive the recording manifest. Leave blank to skip the forwarding step. |
| `TRANSCRIPTION_API_KEY` | Bearer token used by the transcription endpoint. |

## Running the bot

```bash
npm start
```

Once running, invite the bot to your server and mention it from a text channel while you are connected to a voice channel. The bot will hop into your voice channel, begin recording, and acknowledge that it is capturing audio. Mention the bot again with the word `leave`, `stop`, or `done` to end the session. Audio is saved under `tmp/<guildId>/<sessionId>/<userId>/*.pcm`.

If a transcription endpoint is configured, the bot will POST the manifest (list of audio file paths) to the provided `TRANSCRIPTION_URL`. Implement your service to pull the audio files or extend `src/transcription/transcriptionClient.js` to stream the binary payload as required.

## Running with Docker

Build the container image (only needed after code changes):

```bash
docker build -t call-transcribe-bot .
```

Create a `.env` file (or reuse an existing one) with the required secrets, then launch the container:

```bash
docker run --name call-transcribe \
  --env-file .env \
  -v $(pwd)/tmp:/app/tmp \
  call-transcribe-bot
```

Mounting `tmp` keeps recordings on the host so they survive container restarts and can be processed by other services. For deployments on platforms such as DigitalOcean Apps or Droplets, point the service at this image and provide the same environment variables; ensure the bot process can write to `/app/tmp` (use a persistent volume if available).

### docker compose shortcut

```bash
docker compose up --build -d
```

`docker compose down` stops the container while leaving recordings in `./tmp`. Adjust `docker-compose.yml` to set resource limits or add sidecar services (e.g., a transcription worker) as needed.

## Next steps

- Implement the real transcription upload logic inside `src/transcription/transcriptionClient.js` once the API contract is available.
- Optionally convert `.pcm` files to `.wav` (e.g., using `ffmpeg`) before sending them to the transcription service.
- Add persistence/cleanup for old recordings in `tmp` to manage disk usage.
