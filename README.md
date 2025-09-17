# Call Transcribe Bot

Discord bot that joins the voice channel of the user who mentions it, records each participant's audio into individual PCM files, and forwards a manifest to a transcription service for further processing.

## Requirements

- Node.js 22.12 or newer
- Discord application with a bot token
- The following gateway intents enabled for the bot: **Message Content**, **Server Members**, and **Presence** (Message Content is required to detect mentions).
- FFmpeg is **not** required because recording happens through PCM decoding only.
- Native voice support depends on the [DAVE](https://discord.com/blog/addition-of-dave-voice) protocol; the required runtime library `@snazzah/davey` is shipped automatically via npm/dependency installation.

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
| `TRANSCRIPTION_API_KEY` | API key sent to the transcription endpoint. |
| `TRANSCRIPTION_HEADER_NAME` | (Optional) Header name used for the API key. Defaults to `X-API-Key`. |

## Running the bot

```bash
npm start
```

Once running, invite the bot to your server and mention it from a text channel while you are connected to a voice channel. The bot will hop into your voice channel, begin recording, and acknowledge that it is capturing audio. Mention the bot again with the word `leave`, `stop`, or `done` to end the session. Audio is saved under `tmp/<guildId>/<sessionId>/<userId>/*.pcm`.

If a transcription endpoint is configured, the bot will convert each recorded PCM segment to mono 16 kHz WAV and POST it (as `file` in `multipart/form-data`) to the provided `TRANSCRIPTION_URL`, then assemble the returned text into a channel transcript. The API key is sent in the `X-API-Key` header by default; override `TRANSCRIPTION_HEADER_NAME` if your service expects a different header (e.g., `Authorization`).

## Running with Docker

Build the container image (only needed after code changes):

```bash
docker build -t call-transcribe-bot .
```

Create a `.env` file (or reuse an existing one) with the required secrets, then launch the container:

```bash
docker run --name call-transcribe \
  --env-file .env \
  -p 16384:16384 \
  -v $(pwd)/tmp:/app/tmp \
  call-transcribe-bot
```

Mounting `tmp` keeps recordings on the host so they survive container restarts and can be processed by other services. For deployments on platforms such as DigitalOcean Apps or Droplets, point the service at this image and provide the same environment variables; ensure the bot process can write to `/app/tmp` (use a persistent volume if available).

### docker compose shortcut

```bash
docker compose up --build -d
```

`docker compose down` stops the container while leaving recordings in `./tmp`. Adjust `docker-compose.yml` to set resource limits or add sidecar services (e.g., a transcription worker) as needed.

If you bind-mount `./tmp`, ensure the directory on the host is writable by UID 1000 (the `node` user inside the container). For example:

```bash
sudo chown -R 1000:1000 tmp
```

Otherwise the bot cannot create per-guild recording folders and will log `EACCES` errors when it tries to join voice channels.

## Autostart with systemd

To keep the bot running after reboots, install the provided systemd unit (requires sudo privileges):

```bash
./scripts/install_systemd_service.sh
```

The script writes `/etc/systemd/system/call-transcribe-bot.service`, reloads systemd, and enables the service so the container starts at boot. Override the unit name if you manage multiple deployments:

```bash
./scripts/install_systemd_service.sh --service-name my-call-transcribe
```

Check the service status or view logs with the usual systemd commands:

```bash
systemctl status call-transcribe-bot
journalctl -u call-transcribe-bot -f
```

## Exposing the web UI via HTTPS

The bot now ships a lightweight web dashboard on port `16384` (configurable via the `PORT` environment variable). To publish it at `https://transcriptions.velab.dev`, use the helper script below on the host that runs Nginx:

```bash
sudo ./scripts/setup_nginx.sh --email you@example.com
```

Flags you may find useful:

- `--domain` &mdash; change the hostname (default: `transcriptions.velab.dev`).
- `--backend-port` &mdash; update the upstream port if you changed `PORT`.
- `--skip-certbot` &mdash; only write the Nginx config (no certificate request).
- `--staging` &mdash; request a staging certificate while testing.

The script creates `/etc/nginx/sites-available/<domain>.conf`, symlinks it into `sites-enabled`, reloads Nginx, and (by default) obtains a Let's Encrypt certificate using the webroot plugin. Ensure the domain's DNS A/AAAA records already point at your server before running the script.

## Next steps

- Implement the real transcription upload logic inside `src/transcription/transcriptionClient.js` once the API contract is available.
- Optionally convert `.pcm` files to `.wav` (e.g., using `ffmpeg`) before sending them to the transcription service.
- Add persistence/cleanup for old recordings in `tmp` to manage disk usage.
