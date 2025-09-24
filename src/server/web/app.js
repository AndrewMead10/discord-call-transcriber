(function () {
  const sessionListEl = document.getElementById('session-list');
  const sessionDetailEl = document.getElementById('session-detail');

  let sessions = [];
  let activeSessionId = null;
  const audioElements = new Map();
  let fullAudioElement = null;

  function formatDate(value) {
    if (!value) {
      return 'Unknown';
    }
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }
    return date.toLocaleString();
  }

  function clearAudioPlayers() {
    if (fullAudioElement) {
      fullAudioElement.pause();
      fullAudioElement.currentTime = 0;
      fullAudioElement = null;
    }
    for (const { audio } of audioElements.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
    audioElements.clear();
  }

  function updatePlayStates() {
    for (const [segmentId, { audio, button }] of audioElements.entries()) {
      if (!button) {
        continue;
      }
      if (!audio.paused && !audio.ended) {
        button.textContent = '⏸';
        button.setAttribute('aria-label', 'Pause segment audio');
      } else {
        button.textContent = '🔊';
        button.setAttribute('aria-label', 'Play segment audio');
      }
    }
  }

  function stopOthers(exceptId) {
    for (const [segmentId, { audio }] of audioElements.entries()) {
      if (segmentId === exceptId) {
        continue;
      }
      audio.pause();
      audio.currentTime = 0;
    }
  }

  function handlePlayClick(event) {
    const segmentId = event.currentTarget.dataset.segmentId;
    if (!segmentId) {
      return;
    }
    const entry = audioElements.get(segmentId);
    if (!entry) {
      return;
    }

    const { audio } = entry;
    if (audio.paused || audio.ended) {
      stopOthers(segmentId);
      audio.play().catch((error) => {
        console.error('Failed to play audio segment', segmentId, error);
      });
    } else {
      audio.pause();
      audio.currentTime = 0;
    }
    updatePlayStates();
  }

  function createSessionItem(session) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'session-item';
    item.dataset.sessionId = session.id;

    const title = document.createElement('div');
    title.className = 'session-item-title';
    title.textContent = session.guildName || 'Unknown server';
    item.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'session-item-meta';
    meta.textContent = [
      session.channelName || 'Unknown channel',
      formatDate(session.startedAt),
      `${session.participantCount || 0} participants`,
    ]
      .filter(Boolean)
      .join(' • ');
    item.appendChild(meta);

    item.addEventListener('click', () => {
      if (session.id === activeSessionId) {
        return;
      }
      selectSession(session.id);
    });

    if (session.id === activeSessionId) {
      item.classList.add('active');
    }

    return item;
  }

  function renderSessionList() {
    sessionListEl.innerHTML = '';
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'session-item';
      empty.textContent = 'No sessions recorded yet.';
      empty.disabled = true;
      sessionListEl.appendChild(empty);
      return;
    }

    for (const session of sessions) {
      sessionListEl.appendChild(createSessionItem(session));
    }
  }

  function renderSessionDetail(payload) {
    clearAudioPlayers();
    sessionDetailEl.classList.remove('empty');
    sessionDetailEl.innerHTML = '';

    const { session, participants, segments } = payload;

    const header = document.createElement('section');
    header.className = 'session-header';

    const title = document.createElement('h2');
    title.textContent = `${session.guildName || 'Unknown server'} — ${session.channelName || 'Unknown channel'}`;
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = [
      `Started: ${formatDate(session.startedAt)}`,
      `Ended: ${formatDate(session.endedAt)}`,
      `${participants.length} participants`,
    ].join(' | ');
    header.appendChild(meta);

    const shareButton = document.createElement('button');
    shareButton.type = 'button';
    shareButton.className = 'share-button';
    shareButton.textContent = '🔗 Share';
    shareButton.setAttribute('aria-label', 'Copy link to this transcription');
    shareButton.addEventListener('click', () => {
      const shareUrl = `${window.location.origin}/?session=${encodeURIComponent(session.id)}`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        const originalText = shareButton.textContent;
        shareButton.textContent = '✅ Copied!';
        shareButton.style.background = 'rgba(34, 197, 94, 0.15)';
        shareButton.style.borderColor = 'rgba(34, 197, 94, 0.3)';
        setTimeout(() => {
          shareButton.textContent = originalText;
          shareButton.style.background = '';
          shareButton.style.borderColor = '';
        }, 2000);
      }).catch(() => {
        shareButton.textContent = '❌ Failed';
        setTimeout(() => {
          shareButton.textContent = '🔗 Share';
        }, 2000);
      });
    });
    header.appendChild(shareButton);

    sessionDetailEl.appendChild(header);

    if (session.audioUrl) {
      const playback = document.createElement('section');
      playback.className = 'session-playback';

      const playbackTitle = document.createElement('h3');
      playbackTitle.textContent = 'Full Recording';
      playback.appendChild(playbackTitle);

      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'none';
      player.src = session.audioUrl;
      playback.appendChild(player);

      fullAudioElement = player;

      sessionDetailEl.appendChild(playback);
    }

    const participantsContainer = document.createElement('section');
    participantsContainer.className = 'participants';

    const participantsTitle = document.createElement('h3');
    participantsTitle.textContent = 'Participants';
    participantsContainer.appendChild(participantsTitle);

    const participantList = document.createElement('div');
    participantList.className = 'participant-list';
    if (participants.length) {
      for (const participant of participants) {
        const pill = document.createElement('span');
        pill.className = 'participant-pill';
        pill.textContent = participant.displayName || participant.userId;
        participantList.appendChild(pill);
      }
    } else {
      const none = document.createElement('span');
      none.className = 'participant-pill';
      none.textContent = 'No participants recorded';
      participantList.appendChild(none);
    }
    participantsContainer.appendChild(participantList);
    sessionDetailEl.appendChild(participantsContainer);

    const transcriptContainer = document.createElement('section');
    transcriptContainer.className = 'transcript';

    if (!segments.length) {
      const emptySegments = document.createElement('p');
      emptySegments.textContent = 'No transcript segments were saved for this session.';
      transcriptContainer.appendChild(emptySegments);
    } else {
      for (const segment of segments) {
        const segmentEl = document.createElement('article');
        segmentEl.className = 'segment';

        const headerEl = document.createElement('div');
        headerEl.className = 'segment-header';

        const headerMain = document.createElement('div');
        headerMain.className = 'segment-header-main';

        const titleEl = document.createElement('div');
        titleEl.className = 'segment-title';
        titleEl.textContent = segment.label || segment.userId || 'Unknown speaker';
        headerMain.appendChild(titleEl);

        const actions = document.createElement('div');
        actions.className = 'segment-actions';

        if (segment.audioUrl) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'segment-play';
          button.dataset.segmentId = segment.id;
          button.textContent = '🔊';
          button.setAttribute('aria-label', 'Play segment audio');
          button.addEventListener('click', handlePlayClick);

          const audio = document.createElement('audio');
          audio.src = segment.audioUrl;
          audio.preload = 'none';
          audio.hidden = true;

          audio.addEventListener('ended', updatePlayStates);
          audio.addEventListener('pause', updatePlayStates);
          audio.addEventListener('play', updatePlayStates);

          audioElements.set(segment.id, { audio, button });

          actions.appendChild(button);
          actions.appendChild(audio);
        } else {
          const disabledButton = document.createElement('button');
          disabledButton.type = 'button';
          disabledButton.className = 'segment-play';
          disabledButton.textContent = '🔇';
          disabledButton.disabled = true;
          disabledButton.setAttribute('aria-label', 'Audio not available');
          actions.appendChild(disabledButton);
        }

        if (actions.children.length) {
          headerMain.appendChild(actions);
        }

        headerEl.appendChild(headerMain);

        segmentEl.appendChild(headerEl);

        const textEl = document.createElement('div');
        textEl.className = 'segment-text';
        textEl.textContent = segment.text || '';
        segmentEl.appendChild(textEl);

        transcriptContainer.appendChild(segmentEl);
      }
    }

    sessionDetailEl.appendChild(transcriptContainer);

    updatePlayStates();
  }

  function showError(message) {
    sessionDetailEl.classList.remove('empty');
    sessionDetailEl.innerHTML = '';
    const error = document.createElement('p');
    error.textContent = message;
    sessionDetailEl.appendChild(error);
  }

  async function selectSession(sessionId) {
    activeSessionId = sessionId;
    renderSessionList();
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        throw new Error(`Failed to load session: ${response.status}`);
      }
      const payload = await response.json();
      renderSessionDetail(payload);
    } catch (error) {
      console.error('Failed to load session detail', error);
      showError('Failed to load session detail.');
    }
  }

  async function loadSessions() {
    try {
      const response = await fetch('/api/sessions');
      if (!response.ok) {
        throw new Error(`Failed to load sessions: ${response.status}`);
      }
      const payload = await response.json();
      sessions = payload.sessions || [];
      renderSessionList();

      if (!sessions.length) {
      sessionDetailEl.classList.add('empty');
      sessionDetailEl.textContent = 'No sessions available yet.';
      return;
      }

      const urlParams = new URLSearchParams(window.location.search);
      const sessionParam = urlParams.get('session');

      if (sessionParam) {
        const requestedSession = sessions.find((item) => item.id === sessionParam);
        if (requestedSession) {
          selectSession(requestedSession.id);
        } else {
          const initialSession = sessions[0];
          selectSession(initialSession.id);
        }
      } else {
        const initialSession = sessions.find((item) => item.id === activeSessionId) || sessions[0];
        selectSession(initialSession.id);
      }
    } catch (error) {
      console.error('Failed to load sessions', error);
      sessionDetailEl.classList.remove('empty');
      sessionDetailEl.textContent = 'Unable to load sessions.';
    }
  }

  loadSessions();
})();
