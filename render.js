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

// Global host status
let isHost = false;

function initializePeer(asHost) {
    const peerId = randomString(5, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    isHost = asHost;  // Set global host status
    localStorage.setItem("isHost", asHost.toString());  // Also store in localStorage
    
    peer = new Peer(peerId);
    
    peer.on('open', (id) => {
        console.log('Connected to PeerJS with ID:', id);
        if (isHost) {
            console.log('Initialized as host with video:', videoFile?.name);
            document.getElementById("roomCodeText").innerHTML = id;
        }
    });

    peer.on('connection', (conn) => {
        console.log('Incoming connection from:', conn.peer);
        if (isHost && videoFile) {
            console.log('Host ready to stream video:', videoFile.name);
        }
        setupConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        notyf.error("Connection error occurred");
    });
}

function setupConnection(conn) {
    connections[conn.peer] = conn;
    console.log('Setting up connection with peer:', conn.peer);
    
    conn.on('data', (data) => {
        console.log('Received data type:', data.type);
        if (data.type === 'video-chunk') {
            console.log('Received video chunk:', data.offset, '/', data.total);
            handleVideoChunk(data);
        } else if (data.type === 'video-metadata') {
            console.log('Received video metadata for:', data.name);
            handleVideoMetadata(data);
        } else if (data.type === 'video-request') {
            console.log('Received video request, isHost:', isHost);
            console.log('Video file available:', !!videoFile);
            if (isHost && videoFile) {
                console.log('Starting video stream to peer');
                startStreamingTo(conn);
            }
        } else if (data.type === 'chat') {
            append({
                name: data.username,
                content: data.message,
                pfp: data.pfp
            });
        } else if (data.type === 'control') {
            handleVideoControl(data);
        }
    });
    
    conn.on('open', () => {
        console.log('Connection opened to:', conn.peer);
        if (!isHost) {
            console.log('Client requesting video from host');
            // Clear any existing video source for peer
            videoPlayer.src = '';
            conn.send({
                type: 'video-request'
            });
        }
    });

    conn.on('error', (err) => {
        console.error('Connection error:', err);
        notyf.error("Connection error occurred");
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

async function startStreamingTo(conn) {
    try {
        if (!videoFile) {
            throw new Error('No video file available');
        }

        console.log('Starting video stream for peer:', conn.peer);

        // Get the first few bytes to check video header
        const headerChunk = await videoFile.slice(0, 4).arrayBuffer();
        const header = new Uint8Array(headerChunk);
        console.log('Video header bytes:', Array.from(header));

        // Send metadata first with detailed format info
        conn.send({
            type: 'video-metadata',
            name: videoFile.name,
            size: videoFile.size,
            type: videoFile.type,
            lastModified: videoFile.lastModified,
            header: Array.from(header) // Send header bytes for format verification
        });

        // Stream the chunks
        let offset = 0;
        const totalSize = videoFile.size;
        
        while (offset < totalSize) {
            const chunk = videoFile.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunk.arrayBuffer();
            
            conn.send({
                type: 'video-chunk',
                data: buffer,
                offset: offset,
                total: totalSize
            });
            
            offset += buffer.byteLength;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        console.log('Video streaming completed to peer:', conn.peer);
        notyf.success("Video sent to peer");
    } catch (err) {
        console.error('Error streaming video:', err);
        notyf.error("Error streaming video: " + err.message);
    }
}

// Handle incoming video chunks
let receivedChunks = [];
let receivedSize = 0;
let expectedSize = 0;
let videoType = '';

function handleVideoMetadata(data) {
    console.log('Received video metadata:', data);
    expectedSize = data.size;
    videoType = data.type || 'video/webm';  // Ensure we have a default MIME type
    receivedChunks = [];
    receivedSize = 0;
    
    // Clear any existing video
    if (videoPlayer.src) {
        URL.revokeObjectURL(videoPlayer.src);
        videoPlayer.src = '';
    }
    videoFile = null;
    
    console.log('Preparing to receive video:', {
        expectedSize,
        videoType,
        name: data.name
    });
    
    notyf.success("Starting to receive video");
}

function handleVideoChunk(data) {
    try {
        // Store the raw ArrayBuffer data
        receivedChunks.push(data.data);
        receivedSize += data.data.byteLength;
        
        const percentage = Math.round((receivedSize / data.total) * 100);
        console.log(`Received chunk: ${receivedSize}/${data.total} bytes (${percentage}%)`);
        
        if (receivedSize === expectedSize) {
            console.log('All chunks received, creating video blob');
            
            // Combine all chunks into a single ArrayBuffer
            const fullBuffer = new Uint8Array(receivedSize);
            let offset = 0;
            
            for (const chunk of receivedChunks) {
                const chunkArray = new Uint8Array(chunk);
                fullBuffer.set(chunkArray, offset);
                offset += chunk.byteLength;
            }
            
            const blob = new Blob([fullBuffer], { type: videoType });
            console.log('Created blob:', {
                size: blob.size,
                type: blob.type,
                expectedSize: expectedSize
            });
            
            // Create object URL
            const url = URL.createObjectURL(blob);
            
            // Update Video.js source
            player.src({
                src: url,
                type: videoType
            });
            
            player.ready(() => {
                player.load();
                console.log('Video.js player loaded new source');
                notyf.success("Video ready to play");
                
                player.one('loadedmetadata', () => {
                    console.log('Video metadata loaded:', {
                        duration: player.duration(),
                        videoWidth: player.videoWidth(),
                        videoHeight: player.videoHeight()
                    });
                });
            });
            
            receivedChunks = [];
            receivedSize = 0;
        }
    } catch (error) {
        console.error('Error handling video chunk:', error);
        notyf.error("Error processing video chunk: " + error.message);
    }
}

function handleVideoControl(data) {
    if (!allowEmit) return;
    
    if (data.action === 'play' && videoPlayer.paused) {
        videoPlayer.currentTime = data.time;
        videoPlayer.play();
        const content = time("played", data.username || "Someone", data.time);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    } else if (data.action === 'pause' && !videoPlayer.paused) {
        videoPlayer.currentTime = data.time;
        videoPlayer.pause();
        const content = time("paused", data.username || "Someone", data.time);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    }
}

// Helper Functions
function randomString(length, chars) {
    let result = '';
    for (let i = length; i > 0; --i) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function time(state, username, context) {
    let hours = parseInt(Math.round(context) / 60 / 60, 10);
    let minutes = parseInt((context / 60) % 60, 10);
    let seconds = Math.round(context) % 60;
    
    hours = hours < 10 ? "0" + hours.toString() : hours.toString();
    minutes = minutes < 10 ? "0" + minutes.toString() : minutes.toString();
    seconds = seconds < 10 ? "0" + seconds.toString() : seconds.toString();
    
    let contentString = `${username} ${state} the video at ${minutes}:${seconds}`;
    if (hours !== "00") {
        contentString = `${username} ${state} the video at ${hours}:${minutes}:${seconds}`;
    }
    return contentString;
}

// UI Functions
function append(message) {
    const messagesBox = document.getElementById("messages-box");
    messagesBox.innerHTML += `<div class="col-12 mt-3" id="message"><span class="username" style="color: ${message.pfp}">${message.name}: </span>${message.content}</div>`;
    messagesBox.scrollTop = messagesBox.scrollHeight;
}

function appendData(roomName, roomCode) {
    append({name: "Local Party", content: "Local Party allows you to watch local videos with your friends synchronously while chatting.", pfp: "#f3dfbf"});
    append({name: "Local Party", content: `Welcome to ${roomName}`, pfp: "#f3dfbf"});
    append({name: "Local Party", content: `Share the room code (${roomCode}) with others to invite them to the party.`, pfp: "#f3dfbf"});
    append({name: "Local Party", content: "The video will be automatically shared with others who join.", pfp: "#f3dfbf"});
}

// File Handlers
function onChangeFile() {
    const fileInput = document.getElementById("file-id");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    
    const file = fileInput.files[0];
    videoFile = file;
    const url = URL.createObjectURL(file);
    
    // Update Video.js source
    player.src({
        src: url,
        type: file.type
    });
    
    console.log('Video file loaded:', {
        name: file.name,
        size: file.size,
        type: file.type
    });
}

// Video Control Handler
function videoControlsHandler(e) {
    if (!allowEmit) return;
    
    const controlData = {
        type: 'control',
        action: e.type,
        time: player.currentTime()
    };
    
    Object.values(connections).forEach(conn => {
        if (conn.open) {
            conn.send(controlData);
        }
    });
    
    const content = time(e.type === 'play' ? "played" : "paused", "You", player.currentTime());
    append({
        name: "Local Party",
        content: content,
        pfp: "#f3dfbf"
    });
    
    allowEmit = false;
    setTimeout(() => { allowEmit = true; }, 500);
}

// Use Video.js events instead of native video events
player.on('play', videoControlsHandler);
player.on('pause', videoControlsHandler);

// Event Listeners
document.addEventListener("click", function(e) {
    if (e.target.id === "createRoomButton") {
        landingPage.style.display = "none";
        createPage.style.display = "block";
    }
    
    else if (e.target.id === "roomCreateButton") {
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
        
        // Ensure videoFile is set
        if (!videoFile) {
            videoFile = fileInput.files[0];
        }
        
        localStorage.setItem("username", username);
        localStorage.setItem("roomName", roomName);
        
        console.log('Creating room as host with video:', videoFile.name);
        
        // Initialize as host
        initializePeer(true);
        
        document.getElementById("roomNameText").innerHTML = roomName;
        document.getElementById("createRoomText").innerHTML = "";
        createPage.style.display = "none";
        document.title = `Local Party | ${roomName}`;
        roomPage.style.display = "block";
        
        appendData(roomName, peer.id);
    }
    
    else if (e.target.id === "joinRoomButton") {
        landingPage.style.display = "none";
        joinPage.style.display = "block";
        // Hide file input for joining peers
        const fileInput = document.getElementById("file-id");
        if (fileInput) {
            fileInput.style.display = "none";
        }
    }
    
    else if (e.target.id === "roomJoinButton") {
        const hostPeerId = document.getElementById("roomCode").value;
        const username = document.getElementById("join-username").value;
        
        if (!hostPeerId || !username) {
            document.getElementById("joinRoomText").innerHTML = "Please fill in all fields";
            return;
        }
        
        localStorage.setItem("username", username);
        
        // Initialize as non-host
        initializePeer(false);
        
        // Clear any existing video
        videoPlayer.src = '';
        videoFile = null;
        
        peer.on('open', () => {
            console.log('Connecting to host:', hostPeerId);
            const conn = peer.connect(hostPeerId);
            
            conn.on('open', () => {
                console.log('Connected to host successfully');
                setupConnection(conn);
                
                // Immediately request video after connection is established
                console.log('Requesting video from host');
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
    
    else if (e.target.id === "roomLeaveButton") {
        Object.values(connections).forEach(conn => conn.close());
        peer.destroy();
        location.reload();
    }
    
    else if (e.target.id === "backButton") {
        joinPage.style.display = "none";
        createPage.style.display = "none";
        landingPage.style.display = "block";
    }
});

// Chat Form Handler
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

// Initialize UI
document.getElementById('roomCodeText').addEventListener('click', () => {
    const text = document.getElementById('roomCodeText').innerHTML;
    navigator.clipboard.writeText(text).then(() => {
        notyf.success("Copied to clipboard");
    });
});

// Video.js player instance
let player;

// Initialize Video.js player
document.addEventListener('DOMContentLoaded', () => {
    player = videojs('video-player', {
        controls: true,
        preload: 'auto',
        fluid: true,
        html5: {
            vhs: {
                overrideNative: true
            },
            nativeVideoTracks: false,
            nativeAudioTracks: false,
            nativeTextTracks: false
        }
    });
    
    // Add error handling
    player.on('error', function() {
        console.error('Video.js error:', player.error());
    });
});
