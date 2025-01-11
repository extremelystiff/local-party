// Initialize Notyf for notifications
const notyf = new Notyf({ duration: 1500, position: { x: 'center', y: 'top' } });

// PeerJS variables
let peer = null;
let connections = {};
let videoFile = null;
const CHUNK_SIZE = 256 * 1024; // 256KB chunks

// UI elements
const landingPage = document.getElementById("landing");
const createPage = document.getElementById("create");
const joinPage = document.getElementById("join");
const roomPage = document.getElementById("room");
const videoPlayer = document.getElementById("video-player");

// Global status variables
let isHost = false;
let player = null;
let allowEmit = true;
let mediaSource = null;
let sourceBuffer = null;
let pendingChunks = [];
let isBuffering = false;
let receivedSize = 0;
let expectedSize = 0;
let videoType = '';

// Initialize the application
function initializeApp() {
    console.log('Initializing app...');
    
    try {
        // Only initialize if player doesn't exist
        if (!player) {
            player = videojs('video-player', {
                controls: true,
                preload: 'auto',
                fluid: true,
                playsinline: true,
                html5: {
                    vhs: {
                        overrideNative: true
                    },
                    nativeVideoTracks: false,
                    nativeAudioTracks: false,
                    nativeTextTracks: false
                }
            });
            
            console.log('Video.js initialized');
            
            // Set up video player event handlers
            player.on('error', function(error) {
                console.error('Video.js error:', player.error());
                if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
                    processNextChunk();
                }
            });

            player.on('waiting', function() {
                console.log('Video waiting for data');
                if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
                    processNextChunk();
                }
            });

            // Add play/pause event listeners
            player.on('play', videoControlsHandler);
            player.on('pause', videoControlsHandler);
        }

        // Show landing page
        if (landingPage) {
            landingPage.style.display = "block";
            console.log('Landing page displayed');
        }
    } catch (e) {
        console.error('Initialization error:', e);
    }
}

// Initialize on DOM load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Initialize PeerJS connection
function initializePeer(asHost) {
    const peerId = randomString(5, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    isHost = asHost;
    localStorage.setItem("isHost", asHost.toString());
    
    peer = new Peer(peerId);
    
    peer.on('open', (id) => {
        console.log('Connected to PeerJS with ID:', id);
        if (isHost) {
            document.getElementById("roomCodeText").innerHTML = id;
        }
    });

    peer.on('connection', (conn) => {
        console.log('Incoming connection from:', conn.peer);
        setupConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        notyf.error("Connection error occurred");
    });
}

// Set up peer connection
function setupConnection(conn) {
    connections[conn.peer] = conn;
    let metadataInitialized = false;
    
    conn.on('data', async (data) => {
        console.log('Received data type:', data.type);
        
        try {
            switch (data.type) {
                case 'video-metadata':
                    await handleVideoMetadata(data);
                    metadataInitialized = true;
                    // Process any queued chunks after metadata is initialized
                    if (pendingChunks.length > 0) {
                        console.log(`Processing ${pendingChunks.length} queued chunks`);
                        processNextChunk();
                    }
                    break;
                    
                case 'video-chunk':
                    if (!metadataInitialized) {
                        console.log('Queuing chunk while waiting for metadata initialization');
                        pendingChunks.push(new Uint8Array(data.data));
                    } else {
                        handleVideoChunk(data);
                    }
                    break;
                    
                case 'video-request':
                    if (isHost && videoFile) {
                        startStreamingTo(conn);
                    }
                    break;
                    
                case 'chat':
                    append({
                        name: data.username,
                        content: data.message,
                        pfp: data.pfp
                    });
                    break;
                    
                case 'control':
                    handleVideoControl(data);
                    break;
            }
        } catch (error) {
            console.error('Error processing received data:', error);
            notyf.error("Error processing video data: " + error.message);
        }
    });
    
    conn.on('open', () => {
        if (!isHost) {
            conn.send({ type: 'video-request' });
        }
    });

    conn.on('close', () => {
        delete connections[conn.peer];
        append({
            name: 'Local Party',
            content: 'A user has disconnected.',
            pfp: '#f3dfbf'
        });
    });
}


// Start streaming video to peer
async function startStreamingTo(conn) {
    try {
        if (!videoFile) {
            throw new Error('No video file available');
        }

        // Send metadata first
        conn.send({
            type: 'video-metadata',
            name: videoFile.name,
            size: videoFile.size,
            type: videoFile.type,
            lastModified: videoFile.lastModified
        });

        // Stream the chunks
        let offset = 0;
        while (offset < videoFile.size) {
            const chunk = videoFile.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunk.arrayBuffer();
            
            conn.send({
                type: 'video-chunk',
                data: buffer,
                offset: offset,
                total: videoFile.size
            });
            
            offset += buffer.byteLength;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        notyf.success("Video sent to peer");
    } catch (err) {
        console.error('Error streaming video:', err);
        notyf.error("Error streaming video: " + err.message);
    }
}

// Handle incoming video metadata
function handleVideoMetadata(data) {
    console.log('Received video metadata:', data);
    
    return new Promise((resolve, reject) => {
        try {
            // Reset state
            pendingChunks = [];
            receivedSize = 0;
            expectedSize = data.size;
            videoType = data.type || 'video/webm;codecs="vp8,opus"';
            
            console.log(`Initializing stream: size=${expectedSize}, type=${videoType}`);
            
            // Create new MediaSource
            mediaSource = new MediaSource();
            const url = URL.createObjectURL(mediaSource);
            
            mediaSource.addEventListener('sourceopen', () => {
                try {
                    console.log('MediaSource opened, setting up source buffer');
                    sourceBuffer = mediaSource.addSourceBuffer(videoType);
                    sourceBuffer.mode = 'sequence';
                    
                    sourceBuffer.addEventListener('updateend', () => {
                        console.log('Source buffer updated, checking queue');
                        processNextChunk();
                    });
                    
                    // Set up player source after buffer is ready
                    console.log('Setting player source to:', url);
                    player.src({
                        src: url,
                        type: videoType
                    });
                    
                    // Reset player state
                    player.currentTime(0);
                    player.pause();
                    
                    resolve();
                } catch (e) {
                    console.error('Error in sourceopen:', e);
                    reject(e);
                }
            });
            
        } catch (e) {
            console.error('Error in handleVideoMetadata:', e);
            reject(e);
        }
    });
}


// Process next chunk in queue
function processNextChunk() {
    if (!sourceBuffer || !mediaSource || sourceBuffer.updating || pendingChunks.length === 0) {
        return;
    }

    try {
        const chunk = pendingChunks.shift();
        console.log(`Processing chunk of size ${chunk.byteLength}`);
        
        sourceBuffer.appendBuffer(chunk);
        
        // Check buffer status
        if (sourceBuffer.buffered.length > 0) {
            const bufferedEnd = sourceBuffer.buffered.end(0);
            const bufferedStart = sourceBuffer.buffered.start(0);
            const bufferedDuration = bufferedEnd - bufferedStart;
            console.log(`Buffer status: ${bufferedDuration.toFixed(2)}s buffered`);
            
            // If we have enough buffer and video hasn't started playing
            if (bufferedDuration >= 1 && player.paused() && !player.played().length) {
                console.log('Sufficient buffer accumulated, attempting playback');
                player.play()
                    .then(() => {
                        console.log('Playback started successfully');
                        notyf.success("Video playback started");
                    })
                    .catch(err => {
                        console.error('Playback failed:', err);
                        // If play fails, try again in a second
                        setTimeout(() => {
                            if (player.paused()) {
                                player.play().catch(e => console.error('Retry playback failed:', e));
                            }
                        }, 1000);
                    });
            }
        }
    } catch (e) {
        console.error('Error in processNextChunk:', e);
        
        // If we get a QuotaExceededError, clear some buffer
        if (e.name === 'QuotaExceededError' && sourceBuffer.buffered.length > 0) {
            const start = sourceBuffer.buffered.start(0);
            const end = sourceBuffer.buffered.start(0) + 10; // Remove 10 seconds
            sourceBuffer.remove(start, end);
        }
        
        // Requeue the chunk
        pendingChunks.unshift(chunk);
        
        // Try again after a delay
        setTimeout(processNextChunk, 100);
    }
}
// Handle incoming video chunk
function handleVideoChunk(data) {
    const chunk = new Uint8Array(data.data);
    
    // Always queue the chunk, even if metadata isn't ready
    pendingChunks.push(chunk);
    
    if (!expectedSize) {
        console.log('Queuing chunk while waiting for metadata');
        return;
    }
    
    try {
        receivedSize += chunk.byteLength;
        const percentage = Math.round((receivedSize / expectedSize) * 100);
        console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${percentage}%)`);

        // Try to process if source buffer is ready
        if (sourceBuffer && !sourceBuffer.updating) {
            processNextChunk();
        }

        // If this was the last chunk
        if (receivedSize >= expectedSize) {
            console.log('All chunks received, finishing stream');
            
            // Wait for all chunks to be processed
            const checkComplete = setInterval(() => {
                if (pendingChunks.length === 0 && !sourceBuffer.updating) {
                    clearInterval(checkComplete);
                    console.log('All chunks processed, ending stream');
                    
                    try {
                        mediaSource.endOfStream();
                        notyf.success("Video fully loaded");
                        
                        // Ensure video is playing if it should be
                        if (!player.paused()) {
                            player.play().catch(e => console.error('Play after complete failed:', e));
                        }
                    } catch (e) {
                        console.error('Error ending stream:', e);
                    }
                }
            }, 100);
        }
    } catch (error) {
        console.error('Error handling video chunk:', error);
        notyf.error("Error processing video chunk: " + error.message);
    }
}

// Handle video controls
function handleVideoControl(data) {
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

// Helper function for generating random strings
function randomString(length, chars) {
    let result = '';
    for (let i = length; i > 0; --i) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

// Format time for messages
function time(state, username, context) {
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
function append(message) {
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
function appendData(roomName, roomCode) {
    append({
        name: "Local Party",
        content: "Local Party allows you to watch local videos with your friends synchronously while chatting.",
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
        content: "The video will be automatically shared with others who join.",
        pfp: "#f3dfbf"
    });
}

// Handle file selection
function onChangeFile() {
    const fileInput = document.getElementById("file-id");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    
    videoFile = fileInput.files[0];
    const url = URL.createObjectURL(videoFile);
    
    player.src({
        src: url,
        type: videoFile.type
    });
}

// Video controls handler
function videoControlsHandler(e) {
    if (!allowEmit || !player) return;
    
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
        
        // Send to all connected peers
        Object.values(connections).forEach(conn => {
            if (conn.open) {
                conn.send(controlData);
            }
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

// Additional video player event listeners
function initializeVideoPlayerEvents() {
    if (!player) return;
    
    // Handle seeking events
    player.on('seeking', () => {
        if (!allowEmit) return;
        
        allowEmit = false;
        const currentTime = player.currentTime();
        
        Object.values(connections).forEach(conn => {
            if (conn.open) {
                conn.send({
                    type: 'control',
                    action: 'seek',
                    time: currentTime,
                    username: localStorage.getItem("username")
                });
            }
        });
        
        setTimeout(() => { allowEmit = true; }, 500);
    });
    
    // Handle buffering events
    player.on('waiting', () => {
        console.log('Video buffering...');
        if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
            processNextChunk();
        }
    });
    
    // Handle playback errors
    player.on('error', (error) => {
        console.error('Video playback error:', error);
        if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
            processNextChunk();
        }
    });
}

// Set up event listeners
document.addEventListener("click", function(e) {
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
            const fileInput = document.getElementById("file-id");
            if (fileInput) fileInput.style.display = "none";
            break;
            
        case "roomJoinButton":
            handleRoomJoin();
            break;
            
        case "roomLeaveButton":
            Object.values(connections).forEach(conn => conn.close());
            peer.destroy();
            location.reload();
            break;
            
        case "backButton":
            joinPage.style.display = "none";
            createPage.style.display = "none";
            landingPage.style.display = "block";
            break;
    }
});

// Handle room creation
function handleRoomCreate() {
    const roomName = document.getElementById("roomname").value;
    const username = document.getElementById("create-username").value;
    
    if (!roomName || !username) {
        document.getElementById("createRoomText").innerHTML = "Please fill in all fields";
        return;
    }
    
    const fileInput = document.getElementById("file-id");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        document.getElementById("createRoomText").innerHTML = "Please select a video file";
        return;
    }
    
    if (!videoFile) {
        videoFile = fileInput.files[0];
    }
    
    localStorage.setItem("username", username);
    localStorage.setItem("roomName", roomName);
    
    initializePeer(true);
    
    document.getElementById("roomNameText").innerHTML = roomName;
    document.getElementById("createRoomText").innerHTML = "";
    createPage.style.display = "none";
    document.title = `Local Party | ${roomName}`;
    roomPage.style.display = "block";
    
    appendData(roomName, peer.id);
}

// Handle room joining
function handleRoomJoin() {
    const hostPeerId = document.getElementById("roomCode").value;
    const username = document.getElementById("join-username").value;
    
    if (!hostPeerId || !username) {
        document.getElementById("joinRoomText").innerHTML = "Please fill in all fields";
        return;
    }
    
    localStorage.setItem("username", username);
    
    initializePeer(false);
    
    // Clear any existing video
    if (player) {
        player.reset();
    }
    videoFile = null;
    
    peer.on('open', () => {
        console.log('Connecting to host:', hostPeerId);
        const conn = peer.connect(hostPeerId);
        
        conn.on('open', () => {
            console.log('Connected to host successfully');
            setupConnection(conn);
            
            conn.send({
                type: 'video-request'
            });
            
            document.getElementById("roomCodeText").innerHTML = hostPeerId;
            joinPage.style.display = "none";
            document.title = "Local Party | Room";
            roomPage.style.display = "block";
            appendData("Room", hostPeerId);
        });
        
        conn.on('error', (err) => {
            console.error('Connection error:', err);
            document.getElementById("joinRoomText").innerHTML = "Failed to connect to room";
            notyf.error("Failed to connect to room");
        });
    });
}

// Set up chat form handling
const form = document.getElementById("send-form");
form.addEventListener('submit', (e) => {
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
        
        Object.values(connections).forEach(conn => {
            if (conn.open) {
                conn.send(chatData);
            }
        });
        
        append({
            name: localStorage.getItem("username"),
            content: message,
            pfp: localStorage.getItem("pfpUrl") || "#f3dfbf"
        });
        
        messageInput.value = "";
    }
});

// Set up room code click-to-copy
document.getElementById('roomCodeText').addEventListener('click', () => {
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
