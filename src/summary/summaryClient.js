const OpenAI = require('openai');

function cleanText(value) {
  if (typeof value !== 'string') {
    return value == null ? '' : String(value);
  }
  return value;
}

function extractMessageContent(message) {
  if (!message) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content.trim();
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part.text === 'string') {
          return part.text;
        }
        if (typeof part === 'object' && part !== null && typeof part.value === 'string') {
          return part.value;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

class SummaryClient {
  constructor({ baseUrl, apiKey, timeoutMs } = {}) {
    this.baseUrl = baseUrl?.trim() || null;
    this.apiKey = apiKey?.trim() || null;
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 60_000;
    this._client = null;
    this._modelPromise = null;

    if (this.baseUrl && this.apiKey) {
      this._client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
        timeout: this.timeoutMs,
      });
    }
  }

  isConfigured() {
    return Boolean(this._client);
  }

  async _getModelId() {
    if (!this.isConfigured()) {
      throw new Error('Summary client is not configured');
    }

    if (!this._modelPromise) {
      this._modelPromise = this._loadModelId().catch((error) => {
        this._modelPromise = null;
        throw error;
      });
    }

    return this._modelPromise;
  }

  async _loadModelId() {
    const response = await this._client.models.list();
    const models = Array.isArray(response?.data) ? response.data : [];
    if (!models.length) {
      throw new Error('LLM server returned no models');
    }

    const first = models[0];
    if (!first) {
      throw new Error('LLM server returned an empty model entry');
    }

    if (typeof first === 'string') {
      return first;
    }

    if (first.id) {
      return first.id;
    }

    throw new Error('Unable to determine model id from LLM response');
  }

  async summarize({ transcript, sessionMetadata, segments } = {}) {
    if (!this.isConfigured()) {
      return { status: 'skipped', reason: 'Summarization service not configured' };
    }

    const cleanedTranscript = cleanText(transcript).trim();
    if (!cleanedTranscript) {
      return { status: 'skipped', reason: 'Transcript was empty' };
    }

    try {
      const model = await this._getModelId();

      const participantNames = Array.isArray(sessionMetadata?.participants)
        ? sessionMetadata.participants
            .map((participant) => participant?.displayName ?? participant?.userId ?? '')
            .filter(Boolean)
        : [];

      const startTimestamp = Number.isFinite(sessionMetadata?.startedAt)
        ? new Date(sessionMetadata.startedAt).toISOString()
        : null;

      const sessionInfoLines = [];
      if (sessionMetadata?.guildName) {
        sessionInfoLines.push(`Server: ${sessionMetadata.guildName}`);
      }
      if (sessionMetadata?.channelName) {
        sessionInfoLines.push(`Channel: ${sessionMetadata.channelName}`);
      }
      if (participantNames.length) {
        sessionInfoLines.push(`Participants: ${participantNames.join(', ')}`);
      }
      if (startTimestamp) {
        sessionInfoLines.push(`Started At: ${startTimestamp}`);
      }

      const segmentSummaries = Array.isArray(segments)
        ? segments
            .filter((segment) => segment?.label && segment?.text)
            .slice(0, 12)
            .map((segment) => `- ${segment.label}: ${cleanText(segment.text).slice(0, 500)}`)
        : [];

      const promptSections = [];
      if (sessionInfoLines.length) {
        promptSections.push(sessionInfoLines.join('\n'));
      }
      if (segmentSummaries.length) {
        promptSections.push('Recent speaking turns:\n' + segmentSummaries.join('\n'));
      }
      promptSections.push('Full transcript:\n' + cleanedTranscript);

      const userPrompt = promptSections.join('\n\n');

      const response = await this._client.chat.completions.create({
        model,
        temperature: 0.3,
        max_tokens: 400,
        messages: [
          {
            role: 'system',
            content: 'You are an assistant that produces concise meeting summaries with key takeaways and action items when possible.',
          },
          {
            role: 'user',
            content: `${userPrompt}\n\nProvide a structured summary with sections for Key Points and Action Items. If a section has no content, state "None noted."`,
          },
        ],
      });

      const summary = extractMessageContent(response?.choices?.[0]?.message);
      if (!summary) {
        throw new Error('LLM response did not include summary text');
      }

      return { status: 'summarized', summary };
    } catch (error) {
      console.error('Summarization failed:', error);
      return { status: 'failed', reason: error.message };
    }
  }
}

module.exports = { SummaryClient };
