const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');

const SOURCE_SAMPLE_RATE = 48_000;
const SOURCE_CHANNELS = 2;
const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNELS = 1;
const BIT_DEPTH = 16;
const SOURCE_FRAME_BYTES = SOURCE_CHANNELS * (BIT_DEPTH / 8);
const MIN_SPLIT_PADDING_MS = 50;
const MIN_PART_DURATION_MS = 80;
const PRIMARY_FILE_FIELD = 'file';
const SECONDARY_FILE_FIELD = 'files';

function resolveSingleUrl(url) {
  if (!url) {
    return null;
  }
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/batch')) {
    return trimmed.slice(0, -'/batch'.length) || null;
  }
  return trimmed || null;
}

function resolveBatchUrl(url) {
  if (!url) {
    return null;
  }
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }
  if (trimmed.endsWith('/batch')) {
    return trimmed;
  }
  return `${trimmed}/batch`;
}

function extractTranscription(bodyText) {
  if (!bodyText) {
    return '';
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (parsed && typeof parsed.transcription === 'string') {
      return parsed.transcription;
    }
    if (parsed && typeof parsed.text === 'string') {
      return parsed.text;
    }
  } catch (_) {
    // Treat non-JSON bodies as plain text responses.
  }

  return bodyText.replace(/^"|"$/g, '').trim();
}

function parseMissingField(bodyText) {
  if (!bodyText) {
    return null;
  }

  try {
    const parsed = JSON.parse(bodyText);
    const details = Array.isArray(parsed?.detail) ? parsed.detail : [];
    for (const item of details) {
      if (!item?.loc) {
        continue;
      }
      const path = Array.isArray(item.loc) ? item.loc : [];
      if (path.length >= 2 && path[0] === 'body' && typeof path[1] === 'string') {
        return path[1];
      }
    }
  } catch (_) {
    // Ignore JSON parse failures; fallback to null.
  }

  return null;
}

class UploadError extends Error {
  constructor(message, { status, bodyText, attemptedField }) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.bodyText = bodyText;
    this.attemptedField = attemptedField;
    this.missingField = parseMissingField(bodyText);
  }
}

async function uploadBatch({ url, uploads, headerName, apiKey }) {
  if (!url) {
    throw new Error('Batch endpoint URL is not configured');
  }
  if (!uploads.length) {
    return { segments: [], errors: [] };
  }

  const formData = new FormData();
  for (const upload of uploads) {
    if (!upload?.wavBuffer) {
      continue;
    }
    const file = new File([upload.wavBuffer], upload.wavFileName, { type: 'audio/wav' });
    formData.append(SECONDARY_FILE_FIELD, file, upload.wavFileName);
  }

  const headers = {};
  if (apiKey) {
    headers[headerName] = apiKey;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new UploadError(`Batch service responded with ${response.status}`, {
      status: response.status,
      bodyText,
      attemptedField: SECONDARY_FILE_FIELD,
    });
  }

  let payload = {};
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch (error) {
      throw new UploadError('Batch response was not valid JSON', {
        status: response.status,
        bodyText,
        attemptedField: SECONDARY_FILE_FIELD,
      });
    }
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const responseErrors = Array.isArray(payload?.errors) ? payload.errors : [];

  const uploadsByName = new Map();
  for (const upload of uploads) {
    uploadsByName.set(upload.wavFileName, {
      upload,
      handled: false,
      errors: [],
    });
  }

  const segments = [];
  const errors = [];

  for (const item of responseErrors) {
    if (!item) {
      continue;
    }
    const filename = item.filename ?? item.file ?? item.name ?? null;
    const detail = typeof item.error === 'string'
      ? item.error
      : typeof item.detail === 'string'
        ? item.detail
        : typeof item.message === 'string'
          ? item.message
          : JSON.stringify(item);
    if (filename && uploadsByName.has(filename)) {
      uploadsByName.get(filename).errors.push(detail);
    } else {
      errors.push({
        userId: null,
        label: filename ?? 'unknown',
        filePath: null,
        startedAt: null,
        reason: detail,
      });
    }
  }

  for (const item of results) {
    if (!item) {
      continue;
    }
    const filename = item.filename ?? item.file ?? item.name ?? null;
    if (!filename) {
      errors.push({
        userId: null,
        label: 'unknown',
        filePath: null,
        startedAt: null,
        reason: 'Batch response entry was missing filename',
      });
      continue;
    }
    const target = uploadsByName.get(filename);
    if (!target) {
      errors.push({
        userId: null,
        label: filename,
        filePath: null,
        startedAt: null,
        reason: 'Received transcription for unknown segment',
      });
      continue;
    }

    const transcription = typeof item.transcription === 'string'
      ? item.transcription
      : typeof item.text === 'string'
        ? item.text
        : '';

    segments.push({
      id: crypto.randomUUID(),
      userId: target.upload.userId,
      label: target.upload.label,
      startedAt: target.upload.startedAt,
      text: transcription.trim(),
      audioPath: target.upload.wavPath,
    });
    target.handled = true;
  }

  for (const { upload, handled, errors: uploadErrors } of uploadsByName.values()) {
    upload.wavBuffer = null;
    if (!handled) {
      const reason = uploadErrors.length
        ? uploadErrors.join('; ')
        : 'No transcription returned for segment';
      errors.push({
        userId: upload.userId,
        label: upload.label,
        filePath: upload.wavPath,
        startedAt: upload.startedAt,
        reason,
      });
    } else if (uploadErrors.length) {
      errors.push({
        userId: upload.userId,
        label: upload.label,
        filePath: upload.wavPath,
        startedAt: upload.startedAt,
        reason: uploadErrors.join('; '),
      });
    }
  }

  return { segments, errors };
}

async function uploadIndividually({ url, uploads, headerName, apiKey }) {
  if (!url) {
    const errors = uploads.map((upload) => {
      upload.wavBuffer = null;
      return {
        userId: upload.userId,
        label: upload.label,
        filePath: upload.wavPath,
        startedAt: upload.startedAt,
        reason: 'Transcription URL is not configured',
      };
    });
    return { segments: [], errors };
  }

  const segments = [];
  const errors = [];

  for (const upload of uploads) {
    const originalBuffer = upload.wavBuffer;
    try {
      let transcription;
      try {
        transcription = await sendSingleUpload({
          url,
          upload,
          headerName,
          apiKey,
          fieldName: PRIMARY_FILE_FIELD,
        });
      } catch (error) {
        if (
          error instanceof UploadError &&
          error.status === 422 &&
          error.missingField === PRIMARY_FILE_FIELD
        ) {
          transcription = await sendSingleUpload({
            url,
            upload: { ...upload, wavBuffer: originalBuffer },
            headerName,
            apiKey,
            fieldName: SECONDARY_FILE_FIELD,
          });
        } else {
          throw error;
        }
      }

      segments.push({
        id: crypto.randomUUID(),
        userId: upload.userId,
        label: upload.label,
        startedAt: upload.startedAt,
        text: transcription.trim(),
        audioPath: upload.wavPath,
      });
    } catch (error) {
      const message = error instanceof UploadError
        ? `Upload failed (${error.attemptedField}): ${error.bodyText || error.message}`
        : `Upload failed: ${error.message}`;
      errors.push({
        userId: upload.userId,
        label: upload.label,
        filePath: upload.wavPath,
        startedAt: upload.startedAt,
        reason: message,
      });
    } finally {
      upload.wavBuffer = null;
    }
  }

  return { segments, errors };
}

async function sendSingleUpload({ url, upload, headerName, apiKey, fieldName }) {
  if (!upload?.wavBuffer) {
    throw new UploadError('Upload buffer was empty', {
      status: 0,
      bodyText: null,
      attemptedField: fieldName,
    });
  }

  const formData = new FormData();
  const file = new File([upload.wavBuffer], upload.wavFileName, { type: 'audio/wav' });
  formData.append(fieldName, file, upload.wavFileName);

  const headers = {};
  if (apiKey) {
    headers[headerName] = apiKey;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new UploadError(`Service responded with ${response.status}`, {
      status: response.status,
      bodyText,
      attemptedField: fieldName,
    });
  }

  const transcription = extractTranscription(bodyText);
  if (typeof transcription !== 'string') {
    throw new UploadError('Transcription response was not a string', {
      status: response.status,
      bodyText,
      attemptedField: fieldName,
    });
  }

  return transcription;
}

function createWavHeader(dataLength, { sampleRate, channels, bitDepth }) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  buffer.writeUInt32LE(byteRate, 28);
  const blockAlign = channels * (bitDepth / 8);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function pcmStereo48kToMono16k(buffer) {
  if (buffer.length === 0) {
    throw new Error('PCM buffer is empty');
  }

  const totalSamples = buffer.length / 2; // int16 samples across both channels
  if (totalSamples % SOURCE_CHANNELS !== 0) {
    throw new Error(`Unexpected PCM sample count for stereo audio: ${totalSamples}`);
  }

  const view = new Int16Array(buffer.buffer, buffer.byteOffset, totalSamples);
  const frameCount = totalSamples / SOURCE_CHANNELS;
  const monoSamples = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const left = view[frame * SOURCE_CHANNELS];
    const right = view[frame * SOURCE_CHANNELS + 1];
    monoSamples[frame] = (left + right) / 2;
  }

  const downsampleFactor = SOURCE_SAMPLE_RATE / TARGET_SAMPLE_RATE;
  if (Math.abs(downsampleFactor - Math.round(downsampleFactor)) > 1e-6) {
    throw new Error(`Downsample factor must be integer; got ${downsampleFactor}`);
  }

  const factor = Math.round(downsampleFactor);
  const downsampledLength = Math.max(1, Math.floor(frameCount / factor));
  const downsampled = new Int16Array(downsampledLength);

  for (let i = 0; i < downsampledLength; i += 1) {
    const start = i * factor;
    let sum = 0;
    let count = 0;
    for (let j = 0; j < factor && start + j < frameCount; j += 1) {
      sum += monoSamples[start + j];
      count += 1;
    }
    const avg = sum / count;
    const clamped = Math.max(-32768, Math.min(32767, Math.round(avg)));
    downsampled[i] = clamped;
  }

  return Buffer.from(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);
}

async function writeWavFromPcm(pcmBuffer, wavPath) {
  if (!pcmBuffer || pcmBuffer.length === 0) {
    throw new Error('PCM buffer is empty');
  }

  const mono16k = pcmStereo48kToMono16k(pcmBuffer);

  const header = createWavHeader(mono16k.length, {
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    bitDepth: BIT_DEPTH,
  });

  const wavBuffer = Buffer.concat([header, mono16k]);
  await fsp.mkdir(path.dirname(wavPath), { recursive: true });
  await fsp.writeFile(wavPath, wavBuffer);
  return wavBuffer;
}

class TranscriptionClient {
  constructor({ url, apiKey, headerName } = {}) {
    this.url = url?.trim() || null;
    this.batchUrl = resolveBatchUrl(this.url);
    this.singleUrl = resolveSingleUrl(this.url);
    this.apiKey = apiKey?.trim() || null;
    this.headerName = headerName?.trim() || 'X-API-Key';
  }

  isConfigured() {
    return Boolean(this.url && this.apiKey);
  }

  async submit(manifest) {
    if (!manifest) {
      return { status: 'failed', reason: 'No manifest provided' };
    }

    if (!this.isConfigured()) {
      return { status: 'skipped', reason: 'Missing transcription endpoint configuration', manifest };
    }

    const labels = manifest.labels ?? {};
    const recordingEntries = Object.entries(manifest.recordings ?? {});
    if (!recordingEntries.length) {
      return { status: 'skipped', reason: 'Manifest contained no recordings' };
    }

    const segments = [];
    const errors = [];
    const pendingUploads = [];

    const startEvents = [];
    for (const [eventUserId, items] of recordingEntries) {
      for (const item of items) {
        if (!item) {
          continue;
        }
        const startedAt = Number.isFinite(item.startedAt) ? item.startedAt : 0;
        startEvents.push({ userId: eventUserId, startedAt });
      }
    }

    startEvents.sort((a, b) => a.startedAt - b.startedAt);

    for (const [userId, items] of recordingEntries) {
      const label = labels[userId] ?? userId;
      for (const item of items) {
        if (!item?.filePath) {
          errors.push({
            userId,
            label,
            filePath: null,
            startedAt: item?.startedAt ?? null,
            reason: 'Recording item was missing a file path',
          });
          continue;
        }

        const startedAt = Number.isFinite(item.startedAt) ? item.startedAt : 0;
        const absolutePath = path.resolve(item.filePath);

        let stats;
        try {
          stats = await fsp.stat(absolutePath);
        } catch (error) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: `Unable to access PCM file: ${error.message}`,
          });
          continue;
        }

        if (!stats.isFile()) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: 'PCM entry was not a file',
          });
          continue;
        }

        if (stats.size === 0) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: 'PCM file was empty',
          });
          continue;
        }

        if (stats.size % SOURCE_FRAME_BYTES !== 0) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: `Unexpected PCM byte length: ${stats.size}`,
          });
          continue;
        }

        const sampleFrames = stats.size / SOURCE_FRAME_BYTES;
        const durationMs = (sampleFrames / SOURCE_SAMPLE_RATE) * 1000;
        const segmentEnd = startedAt + durationMs;

        const splitSet = new Set();
        let lastSplit = null;
        for (const event of startEvents) {
          if (event.startedAt <= startedAt) {
            continue;
          }
          if (event.startedAt >= segmentEnd) {
            break;
          }
          if (event.userId === userId) {
            continue;
          }
          if (event.startedAt - startedAt < MIN_SPLIT_PADDING_MS) {
            continue;
          }
          if (segmentEnd - event.startedAt < MIN_SPLIT_PADDING_MS) {
            continue;
          }
          if (lastSplit !== null && Math.abs(event.startedAt - lastSplit) < MIN_SPLIT_PADDING_MS) {
            continue;
          }
          splitSet.add(event.startedAt);
          lastSplit = event.startedAt;
        }

        const splitTimes = Array.from(splitSet).sort((a, b) => a - b);

        let pcmData;
        try {
          pcmData = await fsp.readFile(absolutePath);
        } catch (error) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: `Failed to load PCM data: ${error.message}`,
          });
          continue;
        }

        const boundaries = [...splitTimes, segmentEnd];
        let previousSample = 0;
        let previousTime = startedAt;
        let partIndex = 0;

        for (const boundaryTime of boundaries) {
          const relativeMs = boundaryTime - startedAt;
          let sampleIndex = Math.round((relativeMs / 1000) * SOURCE_SAMPLE_RATE);
          if (sampleIndex < previousSample) {
            sampleIndex = previousSample;
          }
          if (sampleIndex > sampleFrames) {
            sampleIndex = sampleFrames;
          }

          if (sampleIndex === previousSample) {
            previousTime = boundaryTime;
            continue;
          }

          const byteStart = previousSample * SOURCE_FRAME_BYTES;
          const byteEnd = sampleIndex * SOURCE_FRAME_BYTES;
          const partBuffer = pcmData.subarray(byteStart, byteEnd);
          const partStartTime = previousTime;
          const partDuration = boundaryTime - previousTime;

          previousSample = sampleIndex;
          previousTime = boundaryTime;

          if (!partBuffer.length || partDuration <= 0) {
            continue;
          }

          if (partDuration < MIN_PART_DURATION_MS) {
            // Allow overlapping fragments, but ensure they contain at least one frame.
            const minimumBytes = SOURCE_FRAME_BYTES;
            if (partBuffer.length < minimumBytes) {
              continue;
            }
          }

          partIndex += 1;

          const isOverlapSplit = splitTimes.some((time) => Math.abs(time - partStartTime) < 0.5);
          const adjustedStart = Number.isFinite(partStartTime)
            ? partStartTime + (isOverlapSplit ? 1 : 0)
            : 0;
          const partStartedAt = Number.isFinite(adjustedStart) ? Math.round(adjustedStart) : 0;
          const wavDir = path.join(path.dirname(absolutePath), 'segments');
          const baseName = path.basename(absolutePath, '.pcm');
          const wavFileName = `${baseName}_${partStartedAt}_${partIndex}.wav`;
          const wavPath = path.join(wavDir, wavFileName);

          let wavBuffer;
          try {
            wavBuffer = await writeWavFromPcm(partBuffer, wavPath);
          } catch (error) {
            errors.push({
              userId,
              label,
              filePath: absolutePath,
              startedAt: partStartedAt,
              reason: `Failed to convert PCM: ${error.message}`,
            });
            continue;
          }

          pendingUploads.push({
            userId,
            label,
            startedAt: partStartedAt,
            wavPath,
            wavFileName,
            wavBuffer,
          });
        }
      }
    }

    const sendUpload = async (upload, fieldName) => {
      const formData = new FormData();
      const file = new File([upload.wavBuffer], upload.wavFileName, { type: 'audio/wav' });
      formData.append(fieldName, file, upload.wavFileName);

      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          [this.headerName]: this.apiKey,
        },
        body: formData,
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new UploadError(`Service responded with ${response.status}`, {
          status: response.status,
          bodyText,
          attemptedField: fieldName,
        });
      }

      const transcription = extractTranscription(bodyText);
      if (typeof transcription !== 'string') {
        throw new UploadError('Transcription response was not a string', {
          status: response.status,
          bodyText,
          attemptedField: fieldName,
        });
      }

      return transcription;
    };

    if (pendingUploads.length) {
      let batchHandled = false;
      if (this.batchUrl) {
        try {
          const { segments: batchSegments, errors: batchErrors } = await uploadBatch({
            url: this.batchUrl,
            uploads: pendingUploads,
            headerName: this.headerName,
            apiKey: this.apiKey,
          });
          segments.push(...batchSegments);
          errors.push(...batchErrors);
          batchHandled = batchSegments.length > 0 || batchErrors.length > 0;
        } catch (error) {
          console.warn('Batch transcription request failed, falling back to individual uploads:', error);
        }
      }

      if (!batchHandled) {
        const { segments: singleSegments, errors: singleErrors } = await uploadIndividually({
          url: this.singleUrl || this.url,
          uploads: pendingUploads,
          headerName: this.headerName,
          apiKey: this.apiKey,
        });
        segments.push(...singleSegments);
        errors.push(...singleErrors);
      }
    }

    if (!segments.length) {
      return {
        status: 'failed',
        reason: errors.length ? `All uploads failed: ${JSON.stringify(errors)}` : 'No segments transcribed',
      };
    }

    segments.sort((a, b) => {
      const at = a.startedAt ?? 0;
      const bt = b.startedAt ?? 0;
      return at - bt;
    });

    const transcript = segments
      .map((segment) => `${segment.label}: ${segment.text}`)
      .join('\n');

    return {
      status: 'sent',
      data: {
        transcript,
        segments,
        errors: errors.length ? errors : undefined,
      },
    };
  }
}

module.exports = { TranscriptionClient };
