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

// Initialize PeerJS with random ID
function initializePeer(isHost) {
    const peerId = randomString(5, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
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
        if (localStorage.getItem("isHost") === "true" && videoFile) {
            startStreamingTo(conn);
        }
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        notyf.error("Connection error occurred");
    });
}

// Set up peer connection and handle data
function setupConnection(conn) {
    connections[conn.peer] = conn;
    
    conn.on('data', (data) => {
        if (data.type === 'video-chunk') {
            handleVideoChunk(data);
        } else if (data.type === 'video-metadata') {
            handleVideoMetadata(data);
        } else if (data.type === 'video-request') {
            if (localStorage.getItem("isHost") === "true") {
                startStreamingTo(conn);
            }
        } else if (data.type === 'chat') {
            append({
                name: data.username,
                content: data.message,
                pfp: data.pfp
            });
        }
    });
    
    conn.on('open', () => {
        console.log('Connection opened to:', conn.peer);
        if (localStorage.getItem("isHost") !== "true") {
            conn.send({
                type: 'video-request'
            });
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

// Stream video to peers
async function startStreamingTo(conn) {
    try {
        conn.send({
            type: 'video-metadata',
            name: videoFile.name,
            size: videoFile.size,
            type: videoFile.type
        });

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
            
            offset += CHUNK_SIZE;
            await new Promise(resolve => setTimeout(resolve, 10)); // Prevent overwhelming the connection
        }
    } catch (err) {
        console.error('Error streaming video:', err);
        notyf.error("Error streaming video");
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
    videoType = data.type;
    receivedChunks = [];
    receivedSize = 0;
}

function handleVideoChunk(data) {
    receivedChunks.push(data.data);
    receivedSize += data.data.byteLength;
    
    if (receivedSize === expectedSize) {
        const blob = new Blob(receivedChunks, { type: videoType });
        const url = URL.createObjectURL(blob);
        videoPlayer.src = url;
        receivedChunks = [];
        notyf.success("Video received successfully");
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
    append({name: "Local Party", content: `Share the room code (${roomCode}) with others to invite them to the party.`, pff: "#f3dfbf"});
    append({name: "Local Party", content: "The video will be automatically shared with others who join.", pfp: "#f3dfbf"});
}

// File Handlers
function onChangeFile() {
    const file = document.getElementById("file-id").files[0];
    if (file) {
        videoFile = file;
        const path = (window.URL || window.webkitURL).createObjectURL(file);
        localStorage.setItem("videoPath", path);
        localStorage.setItem("videoSize", file.size);
        videoPlayer.src = path;
    }
}

function onChangeJoinFile() {
    const file = document.getElementById("join-file-id").files[0];
    if (file) {
        videoFile = file;
        const path = (window.URL || window.webkitURL).createObjectURL(file);
        localStorage.setItem("videoPath", path);
        localStorage.setItem("videoSize", file.size);
        videoPlayer.src = path;
    }
}

// Video Control Handler
let allowEmit = true;

function videoControlsHandler(e) {
    if (!allowEmit) return;
    
    const controlData = {
        type: 'control',
        action: e.type,
        time: videoPlayer.currentTime
    };
    
    Object.values(connections).forEach(conn => {
        if (conn.open) {
            conn.send(controlData);
        }
    });
    
    const content = time(e.type === 'play' ? "played" : "paused", "You", videoPlayer.currentTime);
    append({
        name: "Local Party",
        content: content,
        pfp: "#f3dfbf"
    });
    
    allowEmit = false;
    setTimeout(() => { allowEmit = true; }, 500);
}

videoPlayer.addEventListener('play', videoControlsHandler);
videoPlayer.addEventListener('pause', videoControlsHandler);

// Event Listeners
document.addEventListener("click", function(e) {
    if (e.target.id === "createRoomButton") {
        landingPage.style.display = "none";
        createPage.style.display = "block";
    }
    
    else if (e.target.id === "roomCreateButton") {
        const roomName = document.getElementById("roomname").value;
        const username = document.getElementById("create-username").value;
        
        if (!roomName || !username || !videoFile) {
            document.getElementById("createRoomText").innerHTML = "Please fill in all fields and select a video file";
            return;
        }
        
        localStorage.setItem("isHost", "true");
        localStorage.setItem("username", username);
        localStorage.setItem("roomName", roomName);
        
        initializePeer(true);
        
        document.getElementById("roomNameText").innerHTML = roomName;
        createPage.style.display = "none";
        document.title = `Local Party | ${roomName}`;
        roomPage.style.display = "block";
        
        appendData(roomName, peer.id);
    }
    
    else if (e.target.id === "joinRoomButton") {
        landingPage.style.display = "none";
        joinPage.style.display = "block";
    }
    
    else if (e.target.id === "roomJoinButton") {
        const roomCode = document.getElementById("roomCode").value;
        const username = document.getElementById("join-username").value;
        
        if (!roomCode || !username) {
            document.getElementById("joinRoomText").innerHTML = "Please fill in all fields";
            return;
        }
        
        localStorage.setItem("isHost", "false");
        localStorage.setItem("username", username);
        
        initializePeer(false);
        const conn = peer.connect(roomCode);
        setupConnection(conn);
        
        document.getElementById("roomCodeText").innerHTML = roomCode;
        joinPage.style.display = "none";
        document.title = "Local Party | Room";
        roomPage.style.display = "block";
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

// Show landing page on load
landingPage.style.display = "block";
