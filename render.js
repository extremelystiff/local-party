// Initialize Notyf for notifications
const notyf = new Notyf({ duration: 1500, position: { x: 'center', y: 'top' } });

// PeerJS variables (REMOVED - using WebRTC signaling now)
// let peer = null;
// let connections = {};

// WebRTC variables
let ws = null; // WebSocket connection to signaling server
let localPeerConnection = null; // RTCPeerConnection for local peer
let remotePeerConnections = {}; // Store RTCPeerConnections for remote peers
let localStream = null; // Store the local webcam stream
const CHUNK_SIZE = 64 * 1024; // Reduced chunk size for live stream (adjust as needed)
let isStreaming = false; // Flag to control live streaming
let myID; // ID assigned by the signaling server

// UI elements (same as before)
const landingPage = document.getElementById("landing");
const createPage = document.getElementById("create");
const joinPage = document.getElementById("join");
const roomPage = document.getElementById("room");
const videoPlayer = document.getElementById("video-player");

// Global status variables (same as before, adapt if needed)
let isHost = false;
let player = null;
let allowEmit = true;
let mediaSource = null;
let sourceBuffer = null;
let pendingChunks = [];
let receivedChunks = [];
let isFirstChunk = true;
let isBuffering = false;
let receivedSize = 0;
let expectedSize = 0;
let videoType = 'video/webm; codecs="vp8, vorbis"'; // Default live stream type
let currentTimestamp = 0;
let lastAppendedEnd = 0;
let canvas = null; // Canvas for capturing webcam frames
let context = null; // Canvas context
let videoElementForCapture = null; // Hidden video element to play local stream for capture


const mediaQueue = { // mediaQueue - keep it as it is
    chunks: [],
    isProcessing: false,
    mediaSourceBuffer: null,

    async addChunk(chunk) {
        this.chunks.push(chunk);
        if (!this.isProcessing) {
            await this.processQueue();
        }
    },

    async processQueue() {
        if (this.isProcessing || this.chunks.length === 0) return;

        this.isProcessing = true;
        console.log(`Processing queue with ${this.chunks.length} chunks`);

        try {
            if (!mediaSource || mediaSource.readyState !== 'open') {
                console.log('Creating new MediaSource');
                mediaSource = new MediaSource();
                const videoElement = document.querySelector('#video-player_html5_api');
                videoElement.src = URL.createObjectURL(mediaSource);

                await new Promise(resolve => {
                    mediaSource.addEventListener('sourceopen', resolve, { once: true });
                });
            }

            if (!sourceBuffer) {
                let mimeCodec = videoType; // Use default or detected live stream type
                console.log(`Creating SourceBuffer with MIME type: ${mimeCodec}`);
                sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
                sourceBuffer.mode = 'sequence';
            }

            while (this.chunks.length > 0) {
                const chunk = this.chunks[0]; // Look at first chunk without removing

                if (sourceBuffer.updating) {
                    await new Promise(resolve => {
                        sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    });
                }

                try {
                    console.log(`Appending chunk of size ${chunk.byteLength}`);
                    sourceBuffer.appendBuffer(chunk);

                    await new Promise((resolve, reject) => {
                        const handleUpdateEnd = () => {
                            sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                            sourceBuffer.removeEventListener('error', handleError);
                            resolve();
                        };

                        const handleError = (err) => {
                            sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                            sourceBuffer.removeEventListener('error', handleError);
                            reject(err);
                        };

                        sourceBuffer.addEventListener('updateend', handleUpdateEnd);
                        sourceBuffer.addEventListener('error', handleError);
                    });

                    // Only remove chunk from queue after successful append
                    this.chunks.shift();

                } catch (e) {
                    console.error('Error appending chunk:', e);
                    console.error('DOMException Details:', e);
                    if (e.name === 'QuotaExceededError') {
                        await this.handleQuotaExceeded();
                        continue;
                    }
                    break;
                }
            }

        } catch (e) {
            console.error('Error in queue processing:', e);
        } finally {
            this.isProcessing = false;
            if (this.chunks.length > 0) {
                // Still have chunks to process
                setTimeout(() => this.processQueue(), 100);
            }
        }
    },

    async handleQuotaExceeded() {
        if (!sourceBuffer || !sourceBuffer.buffered.length) return;

        const currentTime = player.currentTime();
        const start = sourceBuffer.buffered.start(0);
        const removeEnd = Math.max(start, currentTime - 10);

        await new Promise((resolve) => {
            sourceBuffer.remove(start, removeEnd);
            sourceBuffer.addEventListener('updateend', resolve, { once: true });
        });
    }
};


// Initialize the application (initializeApp - mostly the same)
function initializeApp() {
    console.log('Initializing app...');

    try {
        // Set global Video.js options first (same)
        videojs.options.techOrder = ['html5'];
        videojs.options.html5 = {
            nativeVideoTracks: false,
            nativeAudioTracks: false,
            nativeTextTracks: false,
            hls: {
                overrideNative: true
            }
        };

        // Only initialize if player doesn't exist (same)
        if (!player) {
            player = videojs('video-player', {
                controls: true,
                preload: 'auto',
                fluid: true,
                playsinline: true,
                autoplay: false,
                html5: {
                    vhs: {
                        overrideNative: true,
                        enableLowInitialPlaylist: true,
                    },
                    nativeVideoTracks: false,
                    nativeAudioTracks: false,
                    nativeTextTracks: false
                }
            });

            console.log('Video.js initialized');

            // Initialize player events (same)
            initializePlayerEvents();

            // Set up buffer monitoring (same)
            setupBufferMonitoring();

            // Initially disable play button until we have data (same)
            if (player.controlBar && player.controlBar.playToggle) {
                player.controlBar.playToggle.disable();
            }
        }

        // Show landing page (same)
        if (landingPage) {
            landingPage.style.display = "block";
            console.log('Landing page displayed');
        }

        // Initialize canvas and video element for frame capture (same)
        canvas = document.createElement('canvas');
        context = canvas.getContext('2d');
        videoElementForCapture = document.createElement('video');
        videoElementForCapture.muted = true; // Mute local video to avoid feedback
        videoElementForCapture.style.display = 'none'; // Hide the capture video element
        document.body.appendChild(videoElementForCapture); // Append to body (can be anywhere)

    } catch (e) {
        console.error('Initialization error:', e);
    }
}

// Initialize on DOM load (same)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}


// Initialize WebRTC signaling (replace initializePeer with initialize signaling)
function initializeSignaling(asHost, groupId) {
    isHost = asHost;
    localStorage.setItem("isHost", asHost.toString());
    const wsServerURL = `ws://localhost:8080/${groupId}`; // Adjust server URL if needed

    ws = new WebSocket(wsServerURL);

    ws.onopen = () => {
        console.log('Connected to WebSocket signaling server');
        if (isHost) {
            document.getElementById("roomCodeText").innerHTML = groupId; // Room code is group ID in this setup
            startWebcamStream(); // Start webcam stream only for the host when room is created
        }
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.id) {
            myID = message.id;
            console.log("My ID from server:", myID);
        } else if (message.from) {
            const fromID = message.from;
            const signal = message.msg;
            handleSignalingMessage(fromID, signal);
        } else if (message.advice) {
            const peerID = message.advice.id;
            const action = message.advice.action;
            if (action === 0 /* Client.CONNECT */) {
                console.log(`Peer ${peerID} connected, action: CONNECT`);
                createPeerConnection(peerID, false); // Not initiator for incoming connection
            } else if (action === -1 /* Client.DISCONNECT */) {
                console.log(`Peer ${peerID} disconnected, action: DISCONNECT`);
                closePeerConnection(peerID);
            }
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        notyf.error("Signaling server connection error");
    };

    ws.onclose = () => {
        console.log('Disconnected from WebSocket signaling server');
        cleanupPeerConnections(); // Clean up connections on server disconnect
    };
}

function sendSignalingMessage(toID, message) {
    ws.send(JSON.stringify({ to: toID, msg: message }));
}


// WebRTC Peer Connection setup
function createPeerConnection(peerID, isInitiator) {
    if (remotePeerConnections[peerID]) {
        console.warn(`Peer connection already exists for ${peerID}`);
        return;
    }

    console.log(`Creating peer connection for ${peerID}, initiator: ${isInitiator}`);
    const pc = new RTCPeerConnection({
        iceServers: [ // Add your ICE servers here (STUN/TURN)
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

    remotePeerConnections[peerID] = pc;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage(peerID, { type: 'candidate', candidate: event.candidate });
        }
    };

    pc.ontrack = (event) => { // Handle remote stream
        console.log(`Track event received from ${peerID}`);
        if (event.streams && event.streams[0]) {
            const remoteStream = event.streams[0];
            console.log('Remote stream received:', remoteStream);
            const videoElement = document.querySelector('#video-player_html5_api');
            videoElement.srcObject = remoteStream; // Set remote stream to video player
            videoElement.play();
        }
    };

    pc.ondatachannel = (event) => { // Handle data channel (if needed in future)
        const dataChannel = event.channel;
        setupDataChannel(dataChannel, peerID);
    };

    pc.onnegotiationneeded = async () => {
        if (isInitiator) {
            try {
                console.log(`Negotiation needed, creating offer for ${peerID}`);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendSignalingMessage(peerID, { type: 'offer', sdp: pc.localDescription });
            } catch (error) {
                console.error('Error creating offer:', error);
            }
        }
    };

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream)); // Add local stream tracks
    }

    if (isInitiator) {
        pc.createDataChannel('liveStreamChannel'); // Create data channel if initiator (can be done for both sides if needed)
    }

    return pc;
}

function handleSignalingMessage(peerID, signal) {
    const pc = remotePeerConnections[peerID];
    if (!pc) {
        console.warn(`No peer connection for ${peerID} to handle signal`);
        return;
    }

    if (signal.type === 'offer') {
        console.log(`Offer received from ${peerID}`);
        pc.setRemoteDescription(new RTCSessionDescription(signal))
            .then(async () => {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendSignalingMessage(peerID, { type: 'answer', sdp: pc.localDescription });
            })
            .catch(error => console.error('Error handling offer:', error));
    } else if (signal.type === 'answer') {
        console.log(`Answer received from ${peerID}`);
        pc.setRemoteDescription(new RTCSessionDescription(signal))
            .catch(error => console.error('Error handling answer:', error));
    } else if (signal.type === 'candidate') {
        pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
            .catch(error => console.error('Error adding ICE candidate:', error));
    }
}

function closePeerConnection(peerID) {
    if (!remotePeerConnections[peerID]) return;
    remotePeerConnections[peerID].close();
    delete remotePeerConnections[peerID];
    console.log(`Peer connection to ${peerID} closed`);
}

function cleanupPeerConnections() {
    Object.keys(remotePeerConnections).forEach(peerID => {
        remotePeerConnections[peerID].close();
    });
    remotePeerConnections = {};
    console.log('All peer connections cleaned up');
}


// Webcam stream functions (startWebcamStream, startLiveStream, captureAndStreamFrame, sendFrameChunks - mostly same, adapt send logic if needed)
function startWebcamStream() {
    if (localStream) {
        startLiveStream(); // If stream already exists, just start streaming
        return;
    }
    navigator.mediaDevices.getUserMedia({ video: true, audio: true }) // Request both video and audio
        .then(stream => {
            localStream = stream;
            videoElementForCapture.srcObject = localStream;
            videoElementForCapture.play(); // Start playing for capture

            // Add local stream to existing peer connections
            Object.values(remotePeerConnections).forEach(pc => {
                localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
            });

            startLiveStream(); // Start streaming after getting the stream
        })
        .catch(error => {
            console.error("Error accessing media devices:", error);
            notyf.error("Could not access webcam/microphone. Live stream not started.");
            isStreaming = false; // Ensure streaming flag is off if stream fails
        });
}


// Function to start the live streaming capture and sending loop
function startLiveStream() {
    if (isStreaming) return; // Prevent starting multiple times
    isStreaming = true;
    console.log('Starting live video capture and streaming...');
    captureAndStreamFrame();
}

// Function to stop live streaming
function stopLiveStream() {
    if (!isStreaming) return;
    isStreaming = false;
    console.log('Stopping live video streaming.');
    // Optionally stop capturing frames here if needed
}


// Capture frames from webcam and stream them
function captureAndStreamFrame() {
    if (!isStreaming || !isHost) return; // Only capture and stream if isStreaming and isHost

    canvas.width = videoElementForCapture.videoWidth;
    canvas.height = videoElementForCapture.videoHeight;
    context.drawImage(videoElementForCapture, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => { // Get frame as Blob (JPEG for smaller size)
        if (!isStreaming || !isHost) return; // Double check before processing Blob

        const reader = new FileReader();
        reader.onloadend = () => {
            const buffer = reader.result; // ArrayBuffer of the frame
            sendFrameChunks(buffer); // Send the frame buffer
        };
        reader.readAsArrayBuffer(blob);
    }, 'image/jpeg', 0.7); // JPEG compression (adjust quality 0-1)

    requestAnimationFrame(captureAndStreamFrame); // Loop for next frame
}


// Function to chunk and send frame data (Adapt to use WebRTC Data Channel if needed, for now direct stream)
function sendFrameChunks(frameBuffer) {
    if (!isStreaming || !isHost) return; // Ensure still streaming before sending

    // For now, we are sending video as MediaStream Tracks.
    // Data channel based chunking is more complex and might be needed for very unreliable networks or specific use-cases.
    // For simplicity, we'll keep streaming as MediaStreamTrack for this initial integration.
    // If you want to use DataChannel for chunking, you would get the data channel for each peer and send chunks via `dataChannel.send(chunk)`.

    // Example of sending data over DataChannel (if you decide to use it later):
    // Object.keys(remotePeerConnections).forEach(peerID => {
    //     const pc = remotePeerConnections[peerID];
    //     const dataChannel = pc.dc_liveStreamChannel; // Assuming you have a data channel named 'liveStreamChannel'
    //     if (dataChannel && dataChannel.readyState === 'open') {
    //         const chunkSize = CHUNK_SIZE;
    //         for (let offset = 0; offset < frameBuffer.byteLength; offset += chunkSize) {
    //             const chunk = frameBuffer.slice(offset, offset + chunkSize);
    //             dataChannel.send(chunk);
    //         }
    //     } else {
    //         console.warn(`Data channel not ready for peer ${peerID}`);
    //     }
    // });
}


let isProcessingChunks = false; // processAllChunks, handleVideoChunk, processNextSegment, processChunkBatch, appendChunkWithRetry, setupSourceBuffer, handleVideoComplete, removeOldBufferData, initializePlayerEvents, handleChatMessage, handleConnectionClose, handleConnectionError, mediaState, setupMediaSource, getVideoMimeType, startStreamingTo, handleVideoMetadata, processNextChunk, initializeMediaSource, retryInitialization, handleQuotaExceeded, appendBufferAsync, isStreamComplete, setupBufferMonitoring, checkBuffer, handleVideoChunk, initializePlayerControls, handleVideoControl, randomString, time, append, appendData, videoControlsHandler, initializeVideoPlayerEvents - Keep all these functions as they are, they are still relevant for buffer management, UI, etc. but adapt if needed for WebRTC context.

async function processAllChunks() { // ... (rest of processAllChunks, processChunkBatch, etc. - keep them as they are, they are still useful for buffer management)
    if (isProcessingChunks) return;
    isProcessingChunks = true;

    console.log(`Starting to process ${pendingChunks.length} chunks`);

    try {
        for (let i = 0; i < pendingChunks.length; i++) {
            if (!sourceBuffer || !mediaSource || mediaSource.readyState !== 'open') {
                console.error('Invalid source buffer or media source state');
                break;
            }

            // Wait if source buffer is updating
            while (sourceBuffer.updating) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            try {
                const chunk = pendingChunks[i];
                sourceBuffer.appendBuffer(chunk);

                // Wait for the append to complete
                await new Promise((resolve, reject) => {
                    sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    sourceBuffer.addEventListener('error', reject, { once: true });
                });

                // Log buffer status
                if (sourceBuffer.buffered.length > 0) {
                    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                    console.log(`Processed chunk ${i + 1}/${pendingChunks.length}, buffer end: ${end.toFixed(2)}s`);
                }

            } catch (e) {
                if (e.name === 'QuotaExceededError') {
                    // Handle quota exceeded by removing old buffer
                    if (sourceBuffer.buffered.length > 0) {
                        const currentTime = player.currentTime();
                        const start = sourceBuffer.buffered.start(0);
                        const removeEnd = Math.max(start, currentTime - 10);

                        await new Promise(resolve => {
                            sourceBuffer.remove(start, removeEnd);
                            sourceBuffer.addEventListener('updateend', resolve, { once: true });
                        });

                        // Retry this chunk
                        i--;
                    }
                } else {
                    console.error(`Error processing chunk ${i + 1}:`, e);
                }
            }
        }

        // Clear processed chunks
        pendingChunks = [];

        // Don't end the stream immediately (live stream is continuous)

    } catch (error) {
        console.error('Error in processAllChunks:', error);
    } finally {
        isProcessingChunks = false;
    }
}

// Helper function to handle video chunk data
function handleVideoChunk(data) { // ... (handleVideoChunk, processNextSegment - keep them, still relevant)
    const chunk = new Uint8Array(data.data);

    // Split large chunks into smaller segments
    if (chunk.byteLength > MAX_SEGMENT_SIZE) {
        let offset = 0;
        while (offset < chunk.byteLength) {
            const size = Math.min(MAX_SEGMENT_SIZE, chunk.byteLength - offset);
            const segment = new Uint8Array(chunk.buffer, offset, size);
            pendingChunks.push(segment);
            offset += size;
        }
    } else {
        pendingChunks.push(chunk);
    }

    receivedSize += chunk.byteLength;
    console.log(`Segmented chunk into ${pendingChunks.length} pieces`);

    if (!sourceBuffer.updating) {
        processNextSegment();
    }
}

// Process segments sequentially
async function processNextSegment() {
    if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) {
        return;
    }

    try {
        const segment = pendingChunks[0];
        sourceBuffer.appendBuffer(segment);

        // Wait for segment to be processed
        await new Promise((resolve, reject) => {
            const handleUpdate = () => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                resolve();
            };

            const handleError = (error) => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                reject(error);
            };

            sourceBuffer.addEventListener('updateend', handleUpdate);
            sourceBuffer.addEventListener('error', handleError);
        });

        // Remove processed segment
        pendingChunks.shift();

        // Log buffer status
        if (sourceBuffer.buffered.length > 0) {
            const start = sourceBuffer.buffered.start(0);
            const end = sourceBuffer.buffered.end(0);
            console.log(`Buffer range: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }

        // Process next segment if available
        if (pendingChunks.length > 0) {
            setTimeout(() => processNextSegment(), 0);
        }

    } catch (error) {
        if (error.name === 'QuotaExceededError') {
            // Remove old buffer data
            if (sourceBuffer.buffered.length > 0) {
                const currentTime = player.currentTime();
                const start = sourceBuffer.buffered.start(0);
                const removeEnd = Math.max(start, currentTime - 10);

                try {
                    await new Promise(resolve => {
                        sourceBuffer.remove(start, removeEnd);
                        sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    });
                    // Retry current segment
                    processNextSegment();
                } catch (e) {
                    console.error('Error removing old buffer:', e);
                }
            }
        } else {
            console.error('Error processing segment:', error);
        }
    }
}
async function processChunkBatch() { // ... (processChunkBatch, appendChunkWithRetry - keep them)
    if (!sourceBuffer || sourceBuffer.updating) return;

    console.log(`Adding ${pendingChunks.length} chunks to queue...`);

    for (const chunk of pendingChunks) {
        await mediaQueue.addChunk(chunk);
    }
    pendingChunks = [];
}
// Helper function to append a chunk with retry logic
async function appendChunkWithRetry(chunk, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            await new Promise((resolve, reject) => {
                if (!sourceBuffer || mediaSource.readyState !== 'open') {
                    reject(new Error('Source buffer or media source not ready'));
                    return;
                }

                const handleUpdateEnd = () => {
                    sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                    sourceBuffer.removeEventListener('error', handleError);
                    resolve();
                };

                const handleError = (err) => {
                    sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                    sourceBuffer.removeEventListener('error', handleError);
                    reject(err);
                };

                sourceBuffer.addEventListener('updateend', handleUpdateEnd);
                sourceBuffer.addEventListener('error', handleError);

                sourceBuffer.appendBuffer(chunk);
            });

            return; // Success, exit function
        } catch (e) {
            attempt++;
            if (e.name === 'QuotaExceededError') {
                await handleQuotaExceeded();
                continue;
            }
            if (attempt === maxRetries) throw e;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
        }
    }
}
function setupSourceBuffer(mimeType) { // ... (setupSourceBuffer - keep it)
    if (!mediaSource || mediaSource.readyState !== 'open') return;

    try {
        if (mimeType === 'video/webm') {
            // Check if it's AV1, use specific MIME type if so, otherwise default to VP8/Vorbis
            if (mimeType.includes('av01')) {
                mimeType = mimeType; // Keep the AV1 MIME type
            } else {
                mimeType = 'video/webm;codecs="vp8,vorbis"'; // Default VP8/Vorbis for generic webm
            }
        }

        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        // Change to 'segments' mode to handle discontinuous appends
        sourceBuffer.mode = 'sequence';
        sourceBuffer.timestampOffset = 0;
        console.log('Created source buffer in segments mode');

        // Initialize timestamp offset to 0
        sourceBuffer.timestampOffset = 0;

        sourceBuffer.addEventListener('updateend', () => {
            if (sourceBuffer.buffered.length > 0) {
                // Log all current ranges
                for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                    console.log(`Buffer range ${i}: ${sourceBuffer.buffered.start(i).toFixed(3)}s to ${sourceBuffer.buffered.end(i).toFixed(3)}s`);
                }
            }
        });

        mediaState.isReady = true;
    } catch (e) {
        console.error('Error setting up source buffer:', e);
        mediaState.hasError = true;
    }
}
// Helper function to handle video complete event
function handleVideoComplete() { // ... (handleVideoComplete - no longer directly used for live stream, but keep it for potential future use)
    console.log('Video transfer complete');

    // Only end the stream if we've processed all segments and the buffer is stable
    const checkComplete = setInterval(() => {
        if (pendingChunks.length === 0 && !sourceBuffer.updating) {
            clearInterval(checkComplete);
            if (mediaSource && mediaSource.readyState === 'open') {
                setTimeout(() => {
                    mediaSource.endOfStream();
                }, 1000);
            }
        }
    }, 500);
}

function removeOldBufferData(currentTime) { // ... (removeOldBufferData - keep it)
    if (!sourceBuffer || !sourceBuffer.buffered.length) return;

    const bufferedStart = sourceBuffer.buffered.start(0);
    const removeEnd = Math.max(bufferedStart, currentTime - 10);

    if (removeEnd > bufferedStart) {
        sourceBuffer.remove(bufferedStart, removeEnd);
    }
}

function initializePlayerEvents() { // ... (initializePlayerEvents - keep it, still important for player control and error handling)
    if (!player) return;

    player.on('waiting', () => {
        console.log('Video waiting for data');

        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();

            console.log('Current source buffer state:', sourceBuffer.updating ? 'updating' : 'idle');
            console.log('Pending chunks:', pendingChunks.length);

            // Log all buffer ranges
            let hasValidRange = false;
            for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                const start = sourceBuffer.buffered.start(i);
                const end = sourceBuffer.buffered.end(i);
                console.log(`Buffer range ${i}: ${start.toFixed(3)}s to ${end.toFixed(3)}s`);

                if (currentTime >= start && currentTime <= end) {
                    hasValidRange = true;
                }
            }

            // If we have pending chunks, process them regardless of valid range
            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                console.log('Processing pending chunks...');
                processChunkBatch(); // Use batch processing instead of single chunks
            } else if (!hasValidRange) {
                console.log('No valid range for current time:', currentTime);
            }
        } else {
            console.log('No buffered ranges available');
            // If we have chunks but no buffer, start processing
            if (pendingChunks.length > 0 && sourceBuffer && !sourceBuffer.updating) {
                console.log('Starting initial chunk processing...');
                processChunkBatch();
            }
        }
    });

    // Add canplay handler
    player.on('canplay', () => {
        console.log('Video can play - enabling play button');
        if (player.controlBar && player.controlBar.playToggle) {
            player.controlBar.playToggle.enable();
        }
    });

    player.on('error', (error) => {
        console.error('Player error:', error);
        console.log('Source buffer state:', sourceBuffer ? sourceBuffer.updating : 'no source buffer');
        console.log('Media source state:', mediaSource ? mediaSource.readyState : 'no media source');
    });

    player.on('timeupdate', () => {
        if (Math.floor(player.currentTime()) % 30 === 0) {
            removeOldBufferData(player.currentTime());
        }
    });

    player.on('dispose', () => {
        if (mediaSource && mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
        }
        if (mediaState.mediaSourceUrl) {
            URL.revokeObjectURL(mediaState.mediaSourceUrl);
        }
    });

    // Add play handler
    player.on('play', () => {
        console.log('Play event triggered');
        if (pendingChunks.length > 0 && sourceBuffer && !sourceBuffer.updating) {
            console.log('Processing chunks on play');
            processChunkBatch();
        }
    });
}
// Helper function to handle chat messages
function handleChatMessage(data) { // ... (handleChatMessage, handleConnectionClose, handleConnectionError - keep them)
    append({
        name: data.username,
        content: data.message,
        pfp: data.pfp || '#f3dfbf'
    });
}

// Helper function to handle connection close
function handleConnectionClose(conn) {
    console.log('Connection closed:', conn.peer);
    delete connections[conn.peer];

    if (mediaState.mediaSourceUrl) {
        URL.revokeObjectURL(mediaState.mediaSourceUrl);
    }

    append({
        name: 'Local Party',
        content: 'A user has disconnected.',
        pfp: '#f3dfbf'
    });
}

// Helper function to handle connection errors
function handleConnectionError(conn, err) {
    console.error('Connection error:', err);
    mediaState.hasError = true;
    notyf.error("Connection error occurred");

    // Clean up
    delete connections[conn.peer];
    if (mediaState.mediaSourceUrl) {
        URL.revokeObjectURL(mediaState.mediaSourceUrl);
    }
}
// State management object
const mediaState = { // ... (mediaState - keep it)
    isReady: false,
    hasError: false,
    mediaSourceReady: false,
    sourceBufferReady: false,
    isInitializing: false,
    mediaSourceUrl: null,
    initComplete: false
};

// Function to set up MediaSource and SourceBuffer
async function setupMediaSource(videoElement, mimeType) { // ... (setupMediaSource - keep it)
    return new Promise((resolve, reject) => {
        try {
            // Reset state
            mediaState.isReady = false;
            mediaState.hasError = false;
            mediaState.initComplete = false;

            // Cleanup existing MediaSource
            if (mediaSource) {
                try {
                    if (mediaSource.readyState === 'open') {
                        mediaSource.endOfStream();
                    }
                } catch (e) {
                    console.warn('Error cleaning up old MediaSource:', e);
                }
                if (mediaState.mediaSourceUrl) {
                    URL.revokeObjectURL(mediaState.mediaSourceUrl);
                }
            }

            // Create new MediaSource
            mediaSource = new MediaSource();
            mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);
            console.log('Created new MediaSource');

            let setupComplete = false;

            const handleSourceOpen = async () => {
                // Prevent multiple executions
                if (setupComplete) return;
                setupComplete = true;

                // Remove the event listener immediately
                mediaSource.removeEventListener('sourceopen', handleSourceOpen);

                try {
                    console.log('MediaSource opened');

                    // Set up SourceBuffer only if it doesn't exist
                    if (!sourceBuffer) {
                        let finalMimeType = mimeType;
                        if (mimeType === 'video/webm') {
                            // Check for AV1 codec - more robust check
                            if (mimeType.includes('av01')) {
                                finalMimeType = mimeType; // Use the full AV1 MIME type from metadata
                            } else {
                                finalMimeType = 'video/webm;codecs="vp8,vorbis"'; // Fallback for VP8/Vorbis
                            }
                        }


                        sourceBuffer = mediaSource.addSourceBuffer(finalMimeType);
                        sourceBuffer.mode = 'sequence';
                        sourceBuffer.timestampOffset = 0;
                        console.log('SourceBuffer created');

                        // Add updateend listener only once
                        sourceBuffer.addEventListener('updateend', () => {
                            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                                processNextChunk();
                            }
                        });
                    }

                    // Update player source only if needed
                    if (player && player.currentSrc() !== mediaState.mediaSourceUrl) {
                        player.src({
                            src: mediaState.mediaSourceUrl,
                            type: mimeType
                        });
                    }

                    mediaState.isReady = true;
                    resolve();
                } catch (error) {
                    console.error('Error in sourceopen:', error);
                    mediaState.hasError = true;
                    reject(error);
                }
            };

            // Add the sourceopen listener with once option
            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });

            // Set video element source
            videoElement.src = mediaState.mediaSourceUrl;

        } catch (error) {
            console.error('Error in setupMediaSource:', error);
            mediaState.hasError = true;
            reject(error);
        }
    });
}
// Helper function to get proper MIME type and codecs (modified for live stream)
function getVideoMimeType(file) { // ... (getVideoMimeType - keep it, or simplify if always using same codec for live stream)
    // For live stream, we are defaulting to webm with vp8/vorbis for simplicity in this example.
    // In a more advanced scenario, you might negotiate codecs or detect browser capabilities and choose accordingly.
    return 'video/webm; codecs="vp8, vorbis"';
}


// Update startStreamingTo to use proper MIME type (modified for live stream) (startStreamingTo - no longer directly used, stream starts with webcam)
async function startStreamingTo(conn) {
    try {
        if (!localStream) { // Now checking for localStream instead of videoFile
            throw new Error('No local webcam stream available');
        }

        console.log('Starting live video stream');

        // Get proper MIME type for live stream (default webm vp8/vorbis for this example)
        const mimeType = getVideoMimeType();
        console.log(`MIME Type detected and being sent: ${mimeType}`);

        // Send metadata with proper MIME type (minimal for live stream)
        const metadata = {
            type: 'video-metadata',
            mimeType: mimeType,
            size: Infinity, // Size is not relevant for live stream
            name: 'live-stream' // Generic name
        };

        console.log('Sending live stream metadata:', metadata);
        conn.send(metadata);

        // Add delay to ensure metadata is processed (might not be strictly needed for live stream, but good practice)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // For live stream, we don't send the whole file at once. The captureAndStreamFrame loop will handle sending frames continuously.
        startLiveStreamingTo(conn); // Start the continuous frame streaming to this connection

        notyf.success("Live stream started to peer");
    } catch (err) {
        console.error('Error starting live stream:', err);
        notyf.error("Error starting live stream: " + err.message);
    }
}


// Handle incoming video metadata (modified for live stream) (handleVideoMetadata - keep it)
function handleVideoMetadata(data) {
    console.log('Processing metadata (live stream):', data);
    expectedSize = data.size || Infinity; // Size not really relevant for live stream

    // Reset state
    pendingChunks = [];
    receivedSize = 0;

    try {
        // Clean up existing MediaSource
        if (mediaSource) {
            if (mediaSource.readyState === 'open') {
                mediaSource.endOfStream();
            }
            if (mediaState.mediaSourceUrl) {
                URL.revokeObjectURL(mediaState.mediaSourceUrl);
            }
        }

        // Create new MediaSource
        mediaSource = new MediaSource();
        mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);
        videoElement.src = mediaState.mediaSourceUrl;

        mediaSource.addEventListener('sourceopen', () => {
            setupSourceBuffer(data.mimeType || 'video/webm; codecs="vp8, vorbis"'); // Use provided or default MIME type
        }, { once: true });

        return true;
    } catch (error) {
        console.error('Error in handleVideoMetadata (live stream):', error);
        mediaState.hasError = true;
        return false;
    }
}


// Process next chunk in queue (processNextChunk, initializeMediaSource, retryInitialization, handleQuotaExceeded, appendBufferAsync, isStreamComplete - keep them)
// Improved chunk processing function with better buffer management
async function processNextChunk() { // ... (processNextChunk - keep it)
    if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) {
        return;
    }

    try {
        const chunk = pendingChunks.shift();
        sourceBuffer.appendBuffer(chunk);
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            // Clean up old data before retrying
            const currentTime = player.currentTime();
            await new Promise(resolve => {
                removeOldBufferData(currentTime);
                sourceBuffer.addEventListener('updateend', resolve, { once: true });
            });
            // Put chunk back at front of queue
            pendingChunks.unshift(chunk);
        } else {
            console.error('Error appending buffer:', e);
        }
    }
}
// Function to handle video metadata with proper initialization
async function initializeMediaSource(videoElement, mimeType) { // ... (initializeMediaSource - keep it)
    if (mediaState.isInitializing) {
        console.log('Already initializing media source');
        return false;
    }

    mediaState.isInitializing = true;
    console.log('Starting media source initialization');

    try {
        // Clean up existing media source
        if (mediaSource) {
            try {
                if (mediaSource.readyState === 'open') {
                    mediaSource.endOfStream();
                }
            } catch (e) {
                console.warn('Error cleaning up old MediaSource:', e);
            }
            if (mediaState.mediaSourceUrl) {
                URL.revokeObjectURL(mediaState.mediaSourceUrl);
            }
        }

        // Reset state
        sourceBuffer = null;
        mediaSource = new MediaSource();
        mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);

        await new Promise((resolve, reject) => {
            const sourceOpenHandler = () => {
                try {
                    console.log('MediaSource opened');

                    // Set up source buffer
                    let finalMimeType = mimeType;
                    if (mimeType === 'video/webm') {
                        // Check for AV1 codec - more robust check
                        if (mimeType.includes('av01')) {
                            finalMimeType = mimeType; // Use the full AV1 MIME type from metadata
                        } else {
                            finalMimeType = 'video/webm;codecs="vp8,vorbis"'; // Fallback for VP8/Vorbis
                        }
                    }

                    sourceBuffer = mediaSource.addSourceBuffer(finalMimeType);
                    sourceBuffer.mode = 'sequence';
                    sourceBuffer.timestampOffset = 0;
                    console.log('SourceBuffer created successfully');

                    // Set up source buffer event listeners
                    sourceBuffer.addEventListener('updateend', () => {
                        if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                            processNextChunk();
                        }
                    });

                    // Update player source
                    if (player) {
                        player.src({
                            src: mediaState.mediaSourceUrl,
                            type: finalMimeType
                        });
                    }

                    resolve();
                } catch (error) {
                    reject(error);
                }
            };

            mediaSource.addEventListener('sourceopen', sourceOpenHandler, { once: true });
            videoElement.src = mediaState.mediaSourceUrl;
        });

        mediaState.isInitializing = false;
        mediaState.isReady = true;
        console.log('Media source initialization complete');
        return true;

    } catch (error) {
        console.error('Media source initialization failed:', error);
        mediaState.hasError = true;
        mediaState.isInitializing = false;
        mediaState.isReady = false;
        throw error;
    }
}

async function retryInitialization(videoElement, mimeType, maxRetries = 3) { // ... (retryInitialization - keep it)
    let attempts = 0;

    while (attempts < maxRetries) {
        try {
            console.log(`Attempt ${attempts + 1} of ${maxRetries} to initialize media source`);

            // Reset state
            mediaState.isReady = false;
            mediaState.hasError = false;
            mediaState.isInitializing = false;
            pendingChunks = [];
            receivedSize = 0;

            const success = await initializeMediaSource(videoElement, mimeType);
            if (success) {
                console.log('Media source initialization succeeded');
                return true;
            }
        } catch (error) {
            console.error(`Attempt ${attempts + 1} failed:`, error);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
        }
        attempts++;
    }

    console.error('All initialization attempts failed');
    return false;
}
// Helper function to handle quota exceeded error
async function handleQuotaExceeded() { // ... (handleQuotaExceeded - keep it)
    if (!sourceBuffer || !sourceBuffer.buffered.length) return;

    const currentTime = player.currentTime();
    const start = sourceBuffer.buffered.start(0);
    const removeEnd = Math.max(start, currentTime - 5);

    if (removeEnd > start) {
        await new Promise((resolve, reject) => {
            sourceBuffer.remove(start, removeEnd);
            sourceBuffer.addEventListener('updateend', resolve, { once: true });
            sourceBuffer.addEventListener('error', reject, { once: true });
        });
    }
}


// Helper function to append buffer with promise
function appendBufferAsync(chunk) { // ... (appendBufferAsync - keep it)
    return new Promise((resolve, reject) => {
        if (!sourceBuffer || mediaSource.readyState !== 'open') {
            reject(new Error('Invalid source buffer state'));
            return;
        }

        try {
            const handleUpdate = () => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                resolve();
            };

            const handleError = (e) => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                reject(e);
            };

            sourceBuffer.addEventListener('updateend', handleUpdate);
            sourceBuffer.addEventListener('error', handleError);
            sourceBuffer.appendBuffer(chunk);

        } catch (e) {
            reject(e);
        }
    });
}

// Helper function to check if stream is complete
function isStreamComplete() { // ... (isStreamComplete - not directly used for live stream, keep for potential future use or cleanup)
    return (
        receivedSize >= expectedSize &&
        pendingChunks.length === 0 &&
        sourceBuffer &&
        !sourceBuffer.updating
    );
}

// Add buffer monitoring to the player (setupBufferMonitoring, checkBuffer - keep them)
// Update setupBufferMonitoring to be more defensive
function setupBufferMonitoring() { // ... (setupBufferMonitoring - keep it)
    if (!player) return;

    // Check buffer status every 500ms
    setInterval(() => {
        if (sourceBuffer && player) {
            const currentTime = player.currentTime();
            removeOldBufferData(currentTime);

            // Rest of buffer monitoring logic...
            if (sourceBuffer.buffered.length > 0) {
                const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                const bufferAhead = bufferedEnd - currentTime;

                console.log(`Buffer status: ${bufferAhead.toFixed(2)}s ahead, ` +
                    `${pendingChunks.length} chunks remaining, ` +
                    `${receivedSize}/${expectedSize} bytes received`);
            }
        }
    }, 500);

    // Handle waiting events more aggressively
    player.on('waiting', () => {
        console.log('Video waiting for data');

        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();

            // Log all buffer ranges
            let hasValidRange = false;
            for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                const start = sourceBuffer.buffered.start(i);
                const end = sourceBuffer.buffered.end(i);
                console.log(`Buffer range ${i}: ${start.toFixed(3)}s to ${end.toFixed(3)}s`);

                if (currentTime >= start && currentTime <= end) {
                    hasValidRange = true;
                }
            }

            if (!hasValidRange && pendingChunks.length > 0) {
                console.log('Current time outside buffered ranges, processing more chunks');
                processNextChunk();
            }
        }
    });

    // Cleanup on player dispose
    player.on('dispose', () => {
        clearInterval(bufferInterval);
    });
}
// Add a buffer check function
function checkBuffer() { // ... (checkBuffer - keep it)
    if (!mediaState.isReady || !sourceBuffer) return;

    try {
        if (sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();
            const bufferedEnd = sourceBuffer.buffered.end(0);
            const bufferAhead = bufferedEnd - currentTime;

            if (bufferAhead < 2 && pendingChunks.length > 0) {
                processNextChunk();
            }
        }
    } catch (e) {
        console.warn('Buffer check error:', e);
    }
}



// Handle incoming video chunk (handleVideoChunk, initializePlayerControls - keep them)
function handleVideoChunk(data) { // ... (handleVideoChunk - keep it, may not be directly used now if using MediaStreamTracks)
    const chunk = new Uint8Array(data.data);
    pendingChunks.push(chunk);
    receivedSize += chunk.byteLength;

    const percentage = ((receivedSize / expectedSize) * 100).toFixed(1);
    console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${percentage}%)`);

    // Process immediately if possible
    if (mediaState.isReady && sourceBuffer && !sourceBuffer.updating) {
        processNextChunk();
    }
}

function initializePlayerControls() { // ... (initializePlayerControls - keep it)
    if (!player) return;

    // Initially disable play button until we have enough data
    player.controlBar.playToggle.disable();

    player.on('canplay', () => {
        console.log('Video can play');
        player.controlBar.playToggle.enable();
    });

    player.on('playing', () => {
        console.log('Video started playing');
    });

    player.on('error', (e) => {
        console.error('Player error:', e);
    });
}
// Handle video controls (handleVideoControl, randomString, time, append, appendData - keep them)
function handleVideoControl(data) { // ... (handleVideoControl - keep it)
    if (!allowEmit || !player) return;

    allowEmit = false;  // Prevent echo

    try {
        // Always sync time first
        if (Math.abs(player.currentTime() - data.time) > 0.5) {
            console.log(`Syncing time from ${player.currentTime()} to ${data.time}`);
            player.currentTime(data.time);
        }

        // Then handle play/pause
        if (data.action === 'play' && player.paused()) {
            console.log('Remote play command received');
            player.play().catch(e => console.error('Play failed:', e));
            const content = time("played", data.username || "Someone", data.time);
            append({
                name: "Local Party",
                content: content,
                pfp: "#f3dfbf"
            });
        } else if (data.action === 'pause' && !player.paused()) {
            console.log('Remote pause command received');
            player.pause();
            const content = time("paused", data.username || "Someone", data.time);
            append({
                name: "Local Party",
                content: content,
                pfp: "#f3dfbf"
            });
        }
    } catch (e) {
        console.error('Error handling video control:', e);
    }

    // Re-enable control emission after a delay
    setTimeout(() => { allowEmit = true; }, 500);
}

// Helper function for generating random strings (randomString, time, append, appendData - keep them)
function randomString(length, chars) {
    let result = '';
    for (let i = length; i > 0; --i) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

// Format time for messages
function time(state, username, context) { // ... (time - keep it)
    let hours = Math.floor(context / 3600);
    let minutes = Math.floor((context % 3600) / 60);
    let seconds = Math.floor(context % 60);

    hours = hours < 10 ? "0" + hours : hours;
    minutes = minutes < 10 ? "0" + minutes : minutes;
    seconds = seconds < 10 ? "0" + seconds : seconds;

    let contentString = `${username} ${state} the video at ${minutes}:${seconds}`;
    if (hours !== "00") {
        contentString = `${username} ${state} the video at ${hours}:${minutes}:${seconds}`;
    }
    return contentString;
}

// Append message to chat
function append(message) { // ... (append - keep it)
    const messagesBox = document.getElementById("messages-box");
    messagesBox.innerHTML += `
        <div class="col-12 mt-3" id="message">
            <span class="username" style="color: ${message.pfp}">${message.name}: </span>
            ${message.content}
        </div>
    `;
    messagesBox.scrollTop = messagesBox.scrollHeight;
}

// Append room data
function appendData(roomName, roomCode) { // ... (appendData - adapt message for live stream)
    append({
        name: "Local Party",
        content: "Local Party allows you to watch live streams with your friends synchronously while chatting.",
        pfp: "#f3dfbf"
    });
    append({
        name: "Local Party",
        content: `Welcome to ${roomName}`,
        pfp: "#f3dfbf"
    });
    append({
        name: "Local Party",
        content: `Share the room code (${roomCode}) with others to invite them to the party.`,
        pfp: "#f3dfbf"
    });
    append({
        name: "Local Party",
        content: "The live stream will be automatically shared with others who join.",
        pfp: "#f3dfbf"
    });
}

// Handle file selection (removed - no longer needed)
// function onChangeFile() { ... }
// function onChangeJoinFile() { ... }

// Video controls handler (videoControlsHandler, initializeVideoPlayerEvents - keep them)
function videoControlsHandler(e) { // ... (videoControlsHandler - keep it)
    if (!allowEmit || !player || !mediaState.isReady) return;

    allowEmit = false;  // Prevent control echo

    try {
        const currentTime = player.currentTime();
        console.log(`Sending ${e.type} command at time ${currentTime}`);

        const controlData = {
            type: 'control',
            action: e.type,
            time: currentTime,
            username: localStorage.getItem("username")
        };

        // Send to all connected peers (adapt if needed for WebRTC peer list)
        Object.keys(remotePeerConnections).forEach(peerID => {
            const pc = remotePeerConnections[peerID];
            // We don't directly send control messages over WebRTC data channel in this example
            // If needed, you would establish a data channel for controls and send messages over it.
            // For now, control is assumed to be managed by the video player directly on each client.
        });

        // Log local action
        const content = time(e.type === 'play' ? "played" : "paused", "You", currentTime);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    } catch (e) {
        console.error('Error in video controls handler:', e);
    }

    // Re-enable control emission after a delay
    setTimeout(() => { allowEmit = true; }, 500);
}

// Additional video player event listeners (initializeVideoPlayerEvents - keep it)
function initializeVideoPlayerEvents() { // ... (initializeVideoPlayerEvents - keep it)
    if (!player) return;

    // Handle seeking events (seeking is less relevant for live stream, but keep it in case user tries to seek in buffer)
    player.on('seeking', () => {
        if (!allowEmit) return;

        allowEmit = false;
        const currentTime = player.currentTime();
        removeOldBufferData(currentTime);

        // Sending seek command over data channel (if needed, for now not implemented in detail)
        // Object.keys(remotePeerConnections).forEach(peerID => {
        //     const pc = remotePeerConnections[peerID];
        //     const dataChannel = pc.dc_controlChannel; // Assuming you have a control data channel
        //     if (dataChannel && dataChannel.readyState === 'open') {
        //         dataChannel.send(JSON.stringify({ type: 'seek', time: currentTime }));
        //     }
        // });

        setTimeout(() => { allowEmit = true; }, 500);
    });

    // Handle buffering events (waiting handler is already in initializePlayerEvents)

    // Handle playback errors (error handler is already in initializePlayerEvents)
}

// Set up event listeners (document.addEventListener - modified for WebRTC)
document.addEventListener("click", function (e) {
    switch (e.target.id) {
        case "createRoomButton":
            landingPage.style.display = "none";
            createPage.style.display = "block";
            break;

        case "roomCreateButton":
            handleRoomCreate();
            break;

        case "joinRoomButton":
            landingPage.style.display = "none";
            joinPage.style.display = "block";
            break;

        case "roomJoinButton":
            handleRoomJoin();
            break;

        case "roomLeaveButton":
            stopLiveStream(); // Stop live stream when leaving room
            cleanupPeerConnections(); // Close all peer connections
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close(); // Close WebSocket connection
            }
            location.reload();
            break;

        case "backButton":
            joinPage.style.display = "none";
            createPage.style.display = "none";
            landingPage.style.display = "block";
            break;
    }
});

// Handle room creation (handleRoomCreate - modified for WebRTC)
function handleRoomCreate() {
    const roomName = document.getElementById("roomname").value;
    const username = document.getElementById("create-username").value;

    if (!roomName || !username) {
        document.getElementById("createRoomText").innerHTML = "Please fill in all fields";
        return;
    }

    localStorage.setItem("username", username);
    localStorage.setItem("roomName", roomName);

    const groupId = randomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789'); // Generate room code/group ID
    initializeSignaling(true, groupId); // Initialize signaling as host with group ID

    document.getElementById("roomNameText").innerHTML = roomName;
    document.getElementById("createRoomText").innerHTML = "";
    createPage.style.display = "none";
    document.title = `Local Party | ${roomName}`;
    roomPage.style.display = "block";

    appendData(roomName, groupId);
}

// Handle room joining (handleRoomJoin - modified for WebRTC)
function handleRoomJoin() {
    const hostGroupId = document.getElementById("roomCode").value; // Room code is group ID
    const username = document.getElementById("join-username").value;

    if (!hostGroupId || !username) {
        document.getElementById("joinRoomText").innerHTML = "Please fill in all fields";
        return;
    }

    localStorage.setItem("username", username);

    initializeSignaling(false, hostGroupId); // Initialize signaling as not host, with group ID

    // Clear any existing video
    if (player) {
        player.reset();
    }

    ws.onopen = () => { // Wait for WebSocket to open before creating peer connection
        document.getElementById("roomCodeText").innerHTML = hostGroupId;
        joinPage.style.display = "none";
        document.title = "Local Party | Room";
        roomPage.style.display = "block";
        appendData("Room", hostGroupId);

        createPeerConnection(myID, true); // Create peer connection to host (initiator) after joining
    };

    ws.onerror = (err) => { // Error handler in case WebSocket connection fails after join attempt
        console.error('Connection error:', err);
        document.getElementById("joinRoomText").innerHTML = "Failed to connect to room";
        notyf.error("Failed to connect to room");
    };
}

// Set up chat form handling (form.addEventListener - keep it)
const form = document.getElementById("send-form");
form.addEventListener('submit', (e) => { // ... (form.addEventListener - keep it)
    e.preventDefault();
    const messageInput = document.getElementById("messageInp");
    const message = messageInput.value.trim();

    if (message) {
        const chatData = {
            type: 'chat',
            username: localStorage.getItem("username"),
            message: message,
            pfp: localStorage.getItem("pfpUrl") || "#f3dfbf"
        };

        // Chat messages are still handled as before (broadcast) - adapt if needed for WebRTC data channel
        // Object.keys(remotePeerConnections).forEach(peerID => {
        //     const pc = remotePeerConnections[peerID];
        //     const dataChannel = pc.dc_chatChannel; // Assuming you have a chat data channel
        //     if (dataChannel && dataChannel.readyState === 'open') {
        //         dataChannel.send(JSON.stringify(chatData));
        //     }
        // });

        append({
            name: localStorage.getItem("username"),
            content: message,
            pfp: localStorage.getItem("pfpUrl") || "#f3dfbf"
        });

        messageInput.value = "";
    }
});
// Add better buffer monitoring (setupBufferMonitoring, logBufferStatus - keep them)
function setupBufferMonitoring() { // ... (setupBufferMonitoring - keep it)
    if (!player) return;

    player.on('timeupdate', () => {
        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();
            const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
            const bufferAhead = bufferedEnd - currentTime;

            console.log(`Buffer status: ${bufferAhead.toFixed(2)}s ahead, ` +
                `${pendingChunks.length} chunks remaining, ` +
                `${receivedSize}/${expectedSize} bytes received`);

            // More aggressive chunk processing
            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                processNextChunk();
            }
        }
    });
}

function logBufferStatus() { // ... (logBufferStatus - keep it)
    if (!sourceBuffer || !player) return;

    const videoElement = player.tech().el();
    console.log("--- Buffer Status Check ---");

    // Log SourceBuffer ranges
    if (sourceBuffer.buffered.length > 0) {
        console.log("SourceBuffer ranges:");
        for (let i = 0; i < sourceBuffer.buffered.length; i++) {
            const start = sourceBuffer.buffered.start(i);
            const end = sourceBuffer.buffered.end(i);
            console.log(`Range ${i}: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }
    }

    // Log Video Element ranges
    if (videoElement.buffered.length > 0) {
        console.log("Video Element ranges:");
        for (let i = 0; i < videoElement.buffered.length; i++) {
            const start = videoElement.buffered.start(i);
            const end = videoElement.buffered.end(i);
            console.log(`Range ${i}: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }
    }
}
// Set up room code click-to-copy (document.getElementById - keep it)
document.getElementById('roomCodeText').addEventListener('click', () => { // ... (document.getElementById - keep it)
    const text = document.getElementById('roomCodeText').innerHTML;
    navigator.clipboard.writeText(text)
        .then(() => {
            notyf.success("Room code copied to clipboard");
        })
        .catch(err => {
            console.error('Failed to copy room code:', err);
            notyf.error("Failed to copy room code");
        });
});
