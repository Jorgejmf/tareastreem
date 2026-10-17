// Lado "emisor": captura cámara/micrófono/pantalla local y transmite a múltiples espectadores (1:N WebRTC).
const localVideo = document.getElementById('localVideo');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

// Streams y fuentes de video
let cameraStream = null;  // Stream original de la cámara web + micrófono
let screenStream = null;  // Stream de captura de pantalla (getDisplayMedia)
let currentSource = 'camera'; // 'camera' | 'screen'
let localStream = null;   // Stream actualmente visible y transmitido
let roomRef = null;       // Referencia a Firebase (rooms/main)
let viewersRef = null;    // Referencia a Firebase para la lista de espectadores

// Mapa con las conexiones activas: viewerId -> { pc, pendingCandidates, answerRef, calleeCandidatesRef }
const peers = new Map();

function setStatus(text) {
  statusEl.textContent = text;
}

function updateStatusText() {
  if (!localStream) {
    setStatus('Transmisión detenida.');
    return;
  }
  const connectedCount = Array.from(peers.values()).filter(
    (p) => p.pc && (p.pc.connectionState === 'connected' || p.pc.iceConnectionState === 'connected')
  ).length;

  const totalCount = peers.size;
  const sourceName = currentSource === 'screen' ? 'escritorio/pantalla' : 'cámara web';
  if (totalCount === 0) {
    setStatus(`Transmitiendo en vivo (${sourceName}). Esperando espectadores...`);
  } else {
    setStatus(`Transmitiendo en vivo (${sourceName}). Espectadores conectados: ${connectedCount} (${totalCount} en total).`);
  }
}

function getActiveVideoTrack() {
  if (currentSource === 'screen' && screenStream && screenStream.getVideoTracks()[0] && screenStream.getVideoTracks()[0].readyState === 'live') {
    return screenStream.getVideoTracks()[0];
  }
  if (cameraStream && cameraStream.getVideoTracks()[0] && cameraStream.getVideoTracks()[0].readyState === 'live') {
    return cameraStream.getVideoTracks()[0];
  }
  return null;
}

function getActiveAudioTrack() {
  if (cameraStream && cameraStream.getAudioTracks()[0]) {
    return cameraStream.getAudioTracks()[0];
  }
  return null;
}

/**
 * Reemplaza la pista de video en todos los RTCPeerConnection activos
 * sin interrumpir la llamada ni requerir renegociación WebRTC.
 */
async function applyActiveVideoTrackToPeers(newVideoTrack) {
  if (!newVideoTrack) return;
  const promises = [];
  for (const [viewerId, peerData] of peers.entries()) {
    if (peerData.pc) {
      const sender = peerData.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        promises.push(
          sender.replaceTrack(newVideoTrack).catch((err) => {
            console.warn(`Error al reemplazar track para espectador ${viewerId}:`, err);
          })
        );
      }
    }
  }
  await Promise.all(promises);
}

/**
 * Inicia la captura de pantalla mediante navigator.mediaDevices.getDisplayMedia()
 */
async function startScreenShare() {
  if (!cameraStream) {
    setStatus('Debes iniciar la transmisión antes de compartir pantalla.');
    return;
  }

  try {
    if (!screenStream || !screenStream.getVideoTracks()[0] || screenStream.getVideoTracks()[0].readyState === 'ended') {
      setStatus('Selecciona la pantalla, ventana o pestaña para compartir...');
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false
      });

      const screenTrack = screenStream.getVideoTracks()[0];

      // Si el usuario detiene la pantalla mediante los controles nativos del navegador ("Dejar de compartir"):
      screenTrack.onended = () => {
        console.log('Captura de pantalla finalizada por el usuario en el navegador.');
        switchToCamera();
      };
    }

    await switchToScreen();
  } catch (err) {
    console.warn('Error al compartir pantalla:', err);
    if (err.name === 'NotAllowedError') {
      setStatus('Captura de pantalla cancelada.');
    } else {
      setStatus('Error al compartir pantalla: ' + err.message);
    }
  }
}

/**
 * Cambia la fuente activa a la pantalla compartida sin cortar la transmisión
 */
async function switchToScreen() {
  if (!screenStream || !screenStream.getVideoTracks()[0] || screenStream.getVideoTracks()[0].readyState === 'ended') {
    await startScreenShare();
    return;
  }

  const screenTrack = screenStream.getVideoTracks()[0];
  currentSource = 'screen';

  // Reemplazar la pista en todos los espectadores conectados
  await applyActiveVideoTrackToPeers(screenTrack);

  // Actualizar preview local
  const audioTracks = cameraStream ? cameraStream.getAudioTracks() : [];
  localStream = new MediaStream([screenTrack, ...audioTracks]);
  localVideo.srcObject = localStream;

  updateSourceUI();
  updateStatusText();
}

/**
 * Cambia la fuente activa a la cámara web sin cortar la transmisión
 */
async function switchToCamera() {
  if (!cameraStream || !cameraStream.getVideoTracks()[0]) {
    return;
  }

  const cameraTrack = cameraStream.getVideoTracks()[0];
  currentSource = 'camera';

  // Reemplazar la pista en todos los espectadores conectados
  await applyActiveVideoTrackToPeers(cameraTrack);

  // Actualizar preview local
  const audioTracks = cameraStream.getAudioTracks();
  localStream = new MediaStream([cameraTrack, ...audioTracks]);
  localVideo.srcObject = localStream;

  updateSourceUI();
  updateStatusText();
}

/**
 * Detiene la captura de pantalla y regresa a la cámara web
 */
async function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }
  await switchToCamera();
}

/**
 * Alterna entre compartir pantalla y cámara web
 */
async function toggleScreenShare() {
  if (currentSource === 'screen') {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
}

function updateSourceUI() {
  const screenBtn = document.getElementById('screenShareBtn');
  const camBtn = document.getElementById('sourceCameraBtn');
  const scrBtn = document.getElementById('sourceScreenBtn');
  const badge = document.getElementById('sourceBadge');
  const badgeText = document.getElementById('sourceBadgeText');

  const isLive = !!localStream;
  const isScreen = currentSource === 'screen';

  if (screenBtn) {
    screenBtn.disabled = !isLive;
    if (isScreen) {
      screenBtn.innerHTML = `
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Detener pantalla
      `;
      screenBtn.classList.add('is-sharing');
    } else {
      screenBtn.innerHTML = `
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Compartir pantalla
      `;
      screenBtn.classList.remove('is-sharing');
    }
  }

  if (camBtn) {
    camBtn.disabled = !isLive;
    camBtn.classList.toggle('active', !isScreen && isLive);
  }
  if (scrBtn) {
    scrBtn.disabled = !isLive;
    scrBtn.classList.toggle('active', isScreen && isLive);
  }

  if (badge && badgeText) {
    if (!isLive) {
      badge.style.display = 'none';
    } else {
      badge.style.display = 'inline-flex';
      if (isScreen) {
        badge.className = 'badge-source screen';
        badgeText.textContent = '🖥️ PANTALLA';
      } else {
        badge.className = 'badge-source camera';
        badgeText.textContent = '📷 CÁMARA';
      }
    }
  }
}

async function start() {
  startBtn.disabled = true;
  setStatus('Solicitando acceso a cámara y micrófono...');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    currentSource = 'camera';
    localStream = cameraStream;
  } catch (err) {
    setStatus('Error al acceder a cámara/micrófono: ' + err.message);
    startBtn.disabled = false;
    return;
  }

  localVideo.srcObject = localStream;

  roomRef = db.ref(ROOM_PATH);
  // Limpia cualquier sesión previa antes de iniciar una nueva.
  await roomRef.remove();

  // Marca la sala como activa y configura desconexión automática si se cierra la pestaña
  await roomRef.child('active').set(true);
  roomRef.child('active').onDisconnect().remove();

  viewersRef = roomRef.child('viewers');

  // Cada vez que un nuevo espectador entra a la sala
  viewersRef.on('child_added', (snapshot) => {
    const viewerId = snapshot.key;
    if (viewerId) {
      handleNewViewer(viewerId);
    }
  });

  // Cuando un espectador se desconecta o cierra su ventana
  viewersRef.on('child_removed', (snapshot) => {
    const viewerId = snapshot.key;
    if (viewerId) {
      removeViewer(viewerId);
    }
  });

  updateSourceUI();
  updateStatusText();
  stopBtn.disabled = false;
}

async function handleNewViewer(viewerId) {
  // Evitar conexiones duplicadas si ya existe
  if (peers.has(viewerId)) {
    return;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peerData = {
    pc,
    pendingCandidates: [],
    answerRef: null,
    calleeCandidatesRef: null
  };
  peers.set(viewerId, peerData);

  // Agregar las pistas de audio/video actuales para este nuevo espectador
  const activeVideoTrack = getActiveVideoTrack();
  const activeAudioTrack = getActiveAudioTrack();

  if (activeVideoTrack && localStream) {
    pc.addTrack(activeVideoTrack, localStream);
  }
  if (activeAudioTrack && localStream) {
    pc.addTrack(activeAudioTrack, localStream);
  }

  // ICE candidates propios dirigidos a este espectador
  const callerCandidatesRef = viewersRef.child(viewerId).child('callerCandidates');
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      callerCandidatesRef.push(event.candidate.toJSON());
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removeViewer(viewerId);
    }
    updateStatusText();
  };

  // Escuchar los ICE candidates enviados por este espectador
  const calleeCandidatesRef = viewersRef.child(viewerId).child('calleeCandidates');
  peerData.calleeCandidatesRef = calleeCandidatesRef;

  calleeCandidatesRef.on('child_added', async (snapshot) => {
    const candidate = snapshot.val();
    if (!candidate) return;

    if (pc.remoteDescription) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Error agregando ICE candidate para espectador ' + viewerId, err);
      }
    } else {
      peerData.pendingCandidates.push(candidate);
    }
  });

  try {
    // Generar oferta personalizada para este espectador
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await viewersRef.child(viewerId).child('offer').set({ type: offer.type, sdp: offer.sdp });

    // Esperar respuesta (answer) del espectador
    const answerRef = viewersRef.child(viewerId).child('answer');
    peerData.answerRef = answerRef;

    answerRef.on('value', async (snapshot) => {
      const answer = snapshot.val();
      if (answer && !pc.currentRemoteDescription) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));

          // Procesar cualquier candidato ICE que haya llegado antes del SDP answer
          for (const cand of peerData.pendingCandidates) {
            await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(console.warn);
          }
          peerData.pendingCandidates = [];
          updateStatusText();
        } catch (err) {
          console.error('Error al aplicar respuesta remota para espectador ' + viewerId, err);
        }
      }
    });
  } catch (err) {
    console.error('Error al negociar conexión con espectador ' + viewerId, err);
    removeViewer(viewerId);
  }
}

function removeViewer(viewerId) {
  const peerData = peers.get(viewerId);
  if (!peerData) return;

  if (peerData.answerRef) peerData.answerRef.off();
  if (peerData.calleeCandidatesRef) peerData.calleeCandidatesRef.off();

  if (peerData.pc) {
    peerData.pc.close();
  }

  peers.delete(viewerId);
  updateStatusText();
}

async function stop() {
  stopBtn.disabled = true;

  // Dejar de escuchar nuevos espectadores
  if (viewersRef) {
    viewersRef.off();
    viewersRef = null;
  }

  // Cerrar todas las conexiones con los espectadores
  for (const viewerId of Array.from(peers.keys())) {
    removeViewer(viewerId);
  }

  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  localStream = null;
  currentSource = 'camera';
  localVideo.srcObject = null;

  // Limpiar la sala en Firebase
  if (roomRef) {
    await roomRef.remove();
    roomRef = null;
  }

  updateSourceUI();
  updateStatusText();
  startBtn.disabled = false;
}

window.addEventListener('beforeunload', () => {
  if (roomRef) {
    roomRef.remove();
  }
});

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);

// Asignar listeners de controles de pantalla y cambio de fuente
document.addEventListener('DOMContentLoaded', () => {
  const screenBtn = document.getElementById('screenShareBtn');
  const camBtn = document.getElementById('sourceCameraBtn');
  const scrBtn = document.getElementById('sourceScreenBtn');

  if (screenBtn) screenBtn.addEventListener('click', toggleScreenShare);
  if (camBtn) camBtn.addEventListener('click', switchToCamera);
  if (scrBtn) scrBtn.addEventListener('click', switchToScreen);

  updateSourceUI();
});