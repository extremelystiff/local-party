// Keep all your existing initial declarations
const notyf = new Notyf({ duration: 1500, position: { x: 'center', y: 'top' } })

// Add new PeerJS-related variables
let peer = null;
let connections = {};
let streamBuffer = [];
const CHUNK_SIZE = 64 * 1024;

// Keep all your existing functions
function randomString(length, chars) {
    var result = '';
    for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function time(state,username,context){
    let hours = parseInt(Math.round(context) / 60 /60, 10);
    let minutes = parseInt((context / 60) % 60, 10);
    let seconds = Math.round(context) % 60
    hours = hours < 10 ? "0" + hours.toString() : hours.toString();
    minutes = minutes < 10 ? '0'+ minutes.toString() : minutes.toString()
    seconds = seconds < 10 ? '0'+ seconds.toString() : seconds.toString()
    let contentString = `${username} ${state} the video at ${minutes}:${seconds}`
    if(hours != 0){
        contentString = `${username} ${state} the video at ${hours}:${minutes}:${seconds}` 
    }
    return contentString
}



const append = message => {
    document.getElementById("messages-box").innerHTML = document.getElementById("messages-box").innerHTML + `<div class="col-12 mt-3" id="message"><span class="username" style="color: ${message.pfp}">${message.name}: </span>${message.content}</div>`
}

function appendData(roomName, roomCode){
    append({name: "Local Party", content: "Local Party allows you to watch local videos with your friends synchronously while chatting.", pfp: "#f3dfbf"})
    append({name: "Local Party", content: `Welcome to ${roomName}`, pfp: "#f3dfbf"})
    append({name: "Local Party", content: `Share the room code (${roomCode}) with others to invite them to the party.`, pfp: "#f3dfbf"})
    append({name: "Local Party", content: "They would need to have the same video file with them to join this watch party.", pfp: "#f3dfbf"})
    append({name: "Local Party", content: "You can change your username in the settings page.", pfp: "#f3dfbf"})
    append({name: "Local Party", content: "Source code for the project is available at https://github.com/sheldor1510/local-party", pfp: "#f3dfbf"})
}

document.getElementById('roomCodeText').addEventListener('click', ()=>{
    let text = document.getElementById('roomCodeText').innerHTML
    navigator.clipboard.writeText(text).then(()=>{
        notyf.success("Copied to clipboard")
    })
})

var videoPlayer = document.getElementById("video-player")
let lastcurrentime = 0;

const landingPage = document.getElementById("landing")
const profilePage = document.getElementById("profile")
const createPage = document.getElementById("create")
const joinPage = document.getElementById("join")
const roomPage = document.getElementById("room")
const socket = io.connect("https://local-party.herokuapp.com")

socket.on('connect', function (socket) {
    console.log('Connected to the server!');   
    landingPage.style.display = "block" 
});


socket.on('user-joined', data => {
    if(data.roomCode == localStorage.getItem("roomCode")){
        append({
            name: data.name,
            content: `${data.name} just popped into the party.`,
            pfp: data.pfp
        })
        document.getElementById("pplinparty").setAttribute("title", `People in party: ${data.members}`)
        var toolTipTriggerList = [].slice.call(document.querySelectorAll('[data-toggle="tooltip"]'));
        toolTipTriggerList.map(function (tooltipTriggerE1){
            return new bootstrap.Tooltip(tooltipTriggerE1)
            });
        document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
    }
})

socket.on('updateMemberInfo', data => {
    if(data.roomCode == localStorage.getItem("roomCode")){
        document.getElementById("pplinparty").setAttribute("title", `People in party: ${data.members}`)
        var toolTipTriggerList = [].slice.call(document.querySelectorAll('[data-toggle="tooltip"]'));
        toolTipTriggerList.map(function (tooltipTriggerE1){
            return new bootstrap.Tooltip(tooltipTriggerE1)
        });
    }
})


socket.on('receive', data => {
    append({
        name: data.name,
        content: data.message,
        pfp: data.pfp
    })
    document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
})

socket.on('left', data => {
    append({
        name: 'Local Party',
        content: `${data.name} left the party.`,
        pfp: '#f3dfbf',
    })
    document.getElementById("pplinparty").setAttribute("title", `People in party: ${data.members}`)
    var toolTipTriggerList = [].slice.call(document.querySelectorAll('[data-toggle="tooltip"]'));
    var toolTipList = toolTipTriggerList.map(function (tooltipTriggerE1){
        return new bootstrap.Tooltip(tooltipTriggerE1)
        });
    document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
})

socket.on('leftdefault', data => {
    append({
        name: 'Local Party',
        content: `${data.name} left the party.`,
        pfp: '#f3dfbf',
    })
    document.getElementById("pplinparty").setAttribute("title", `People in party: ${data.members}`)
    var toolTipTriggerList = [].slice.call(document.querySelectorAll('[data-toggle="tooltip"]'));
    var toolTipList = toolTipTriggerList.map(function (tooltipTriggerE1){
        return new bootstrap.Tooltip(tooltipTriggerE1)
        });
    document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
})


socket.on('playerControlUpdate', data => {
    if(data.message == "play") {
        console.log(data)
        videoPlayer.currentTime = data.context
        allowEmit = false;
        videoPlayer.play()
        let content = time("played", data.username, data.context)
        append({
            name: "Local Party", 
            content: content,
            pfp: "#f3dfbf"
        })
        document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
    }
    if(data.message == "pause") {
        console.log(data)
        videoPlayer.currentTime = data.context
        allowEmit = false;
        videoPlayer.pause()
        let content = time("paused", data.username, data.context)
        append({
            name: "Local Party", 
            content: content,
            pfp: "#f3dfbf"
        })
        document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
    }
})

if(localStorage.getItem("username") == null) {
    localStorage.setItem("username", "unknown")
}

const colors = ['#F26E5C', '#FCE060', '#63E683', '#6085FC', '#F52C93','#00FFFF','#800080','#006400','#FF8C00','#4B0082']

function random_item(items) {
    return items[Math.floor(Math.random() * items.length)];
}

const color = random_item(colors)

if(localStorage.getItem("pfpUrl") == null) {
    localStorage.setItem("pfpUrl", color)
}

document.addEventListener("click", function (e) {
    if(e.target.id == "createRoomButton") {
        landingPage.style.display = "none"
        createPage.style.display = "block"
    }
    if(e.target.id == "roomCreateButton") {
        const roomName = document.getElementById("roomname").value
        if(roomName.length == 0) {
            console.log("error")
            document.getElementById("createRoomText").innerHTML = "Please fill in all the fields"
        } else {
            if(localStorage.getItem("videoPath") == null || localStorage.getItem("videoSize") == null || document.getElementById("create-username").value.length == 0) {
                document.getElementById("createRoomText").innerHTML = "Please fill in all the fields"
            } else {
                localStorage.setItem("roomName", roomName)
                localStorage.setItem("username", document.getElementById("create-username").value)
                const roomCode = randomString(5, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
                document.getElementById("createRoomText").innerHTML = ""
                document.getElementById("roomNameText").innerHTML = roomName
                document.getElementById("roomCodeText").innerHTML = roomCode
                videoPlayer.setAttribute("src", localStorage.getItem("videoPath"))
                var myHeaders = new Headers();
                myHeaders.append("Content-Type", "application/json");

                var raw = JSON.stringify({
                    "roomName": roomName,
                    "roomCode": roomCode,
                    "videoSize": localStorage.getItem("videoSize")
                });

                var requestOptions = {
                    method: 'POST',
                    headers: myHeaders,
                    body: raw,
                    redirect: 'follow'
                };

                fetch("https://local-party.herokuapp.com/room/create", requestOptions)
                .then( async (result) => {
                    const resp = await result.json()
                    if(resp.message == "success") {
                        var toolTipTriggerList = [].slice.call(document.querySelectorAll('[data-toggle="tooltip"]'));
                        var toolTipList = toolTipTriggerList.map(function (tooltipTriggerE1){
                            return new bootstrap.Tooltip(tooltipTriggerE1)
                        });
                        localStorage.setItem("roomCode", roomCode)
                        appendData(roomName, roomCode)
                        socket.emit('new-user-joined', { name: localStorage.getItem("username"), roomCode: roomCode, pfp: localStorage.getItem("pfpUrl") })
                        createPage.style.display = "none"
                        document.title = `Local Party | ${roomName}`
                        roomPage.style.display = "block"
                    }
                })
                .catch(error => console.log('error', error));
            }
        }
    }
    if(e.target.id == "joinRoomButton") {
        landingPage.style.display = "none"
        joinPage.style.display = "block"
    }
    if(e.target.id == "roomJoinButton") {
        const inputRoomCode = document.getElementById("roomCode").value
        if(inputRoomCode.length == 0) {
            document.getElementById("joinRoomText").innerHTML = "Please fill in all the fields"
        } else {
            if(localStorage.getItem("videoPath") == null || localStorage.getItem("videoSize") == null || document.getElementById("join-username").value.length == 0) {
                document.getElementById("joinRoomText").innerHTML = "Please fill in all the fields"
            } else {
                var myHeaders = new Headers();
                myHeaders.append("Content-Type", "application/json");

                var raw = JSON.stringify({
                    "roomCode": inputRoomCode,
                    "videoSize": localStorage.getItem("videoSize")
                });

                var requestOptions = {
                    method: 'POST',
                    headers: myHeaders,
                    body: raw,
                    redirect: 'follow'
                };

                fetch("https://local-party.herokuapp.com/room/join", requestOptions)
                .then( async (result) => {
                    const resp = await result.json()
                    if(resp.message != "success") {
                        document.getElementById("joinRoomText").innerHTML = resp.message
                    } else {
                        document.getElementById("joinRoomText").innerHTML = ""
                        document.getElementById("roomNameText").innerHTML = resp.roomName 
                        document.getElementById("roomCodeText").innerHTML = resp.roomCode
                        var toolTipTriggerList = [].slice.call(document.querySelectorAll('[data-toggle="tooltip"]'));
                        var toolTipList = toolTipTriggerList.map(function (tooltipTriggerE1){
                            return new bootstrap.Tooltip(tooltipTriggerE1)
                        });
                        localStorage.setItem("roomCode", inputRoomCode)
                        localStorage.setItem("username", document.getElementById("join-username").value)
                        videoPlayer.setAttribute("src", localStorage.getItem("videoPath"))
                        appendData(resp.roomName, resp.roomCode)
                        socket.emit('new-user-joined', { name: localStorage.getItem("username"), roomCode: resp.roomCode, pfp: localStorage.getItem("pfpUrl") })
                        joinPage.style.display = "none"
                        document.title = `Local Party | ${resp.roomName}`
                        roomPage.style.display = "block"
                    }   
                })
                .catch(error => console.log('error', error));
            }
        }
    }

    if(e.target.id == "roomLeaveButton") {
        videoPlayer.setAttribute("src", "C:\Users\anshu\Desktop\Anshul\Projects\local-party\src\test.mp4")
        socket.emit('disconnectUser', { roomCode: localStorage.getItem("roomCode"), name: localStorage.getItem("username") , pfp: localStorage.getItem("pfpUrl") })
        location.reload()
    }
    if(e.target.id == "backButton") {
        joinPage.style.display = "none"
        createPage.style.display = "none"
        landingPage.style.display = "block"
    }
})

const form = document.getElementById("send-form")

form.addEventListener('submit', (e) => {
    e.preventDefault()
    const messageInput = document.getElementById("messageInp").value
    if(messageInput.split(" ").join("").length != 0) {
        socket.emit('send', messageInput)
        append({
            name: localStorage.getItem("username"),
            content: messageInput,
            pfp: localStorage.getItem("pfpUrl")
        })
        document.getElementById("messageInp").value = ""
        document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
    }
})

let allowEmit = true;

videoPlayer.addEventListener('play', videoControlsHandler, false);
videoPlayer.addEventListener('pause', videoControlsHandler, false);
videoPlayer.addEventListener('d', videoControlsHandler, false);

function videoControlsHandler(e) {
    if (e.type == 'play') {
        if(allowEmit == true){
            socket.emit("playerControl", {message: "play", context: videoPlayer.currentTime, roomCode: localStorage.getItem("roomCode")}) 
            let content = time("played","You", videoPlayer.currentTime)
            append({
                name: "Local Party", 
                content: content,
                pfp: "#f3dfbf"
            })
            document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
        } 
        setTimeout(() => {
            allowEmit = true
        }, 500);
    } else if (e.type == 'pause') {
        if(allowEmit == true){
            socket.emit("playerControl", {message: "pause", context: videoPlayer.currentTime, roomCode: localStorage.getItem("roomCode")})
            let content = time("paused","You", videoPlayer.currentTime)
            append({
                name: "Local Party", 
                content: content,
                pfp: "#f3dfbf"
            })
            document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight
        }
        setTimeout(() => {
            allowEmit = true
        }, 500);
    }
}

function onChangeFile() {
    const file = document.getElementById("file-id").files[0];
    if (file) {
        localStorage.setItem("videoSize", file.size);
        if (localStorage.getItem("isHost") === "true") {
            // For host: Keep the file for streaming
            localStorage.setItem("videoFile", file);
        } else {
            // For non-host: Still create object URL as fallback
            const path = (window.URL || window.webkitURL).createObjectURL(file);
            localStorage.setItem("videoPath", path);
        }
    }
}

function onChangeJoinFile() {
    const file = document.getElementById("join-file-id").files[0];
    if (file) {
        localStorage.setItem("videoSize", file.size);
        const path = (window.URL || window.webkitURL).createObjectURL(file);
        localStorage.setItem("videoPath", path);
    }
}

// Add PeerJS initialization function
function initializePeer(isHost) {
    peer = new Peer(randomString(10, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'));
    
    peer.on('open', (id) => {
        console.log('Connected to PeerJS with ID:', id);
        if(isHost) {
            localStorage.setItem('hostPeerId', id);
        }
    });

    peer.on('connection', (conn) => {
        setupConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        notyf.error("Connection error. Please try rejoining.");
    });
}

// Add connection handling
function setupConnection(conn) {
    connections[conn.peer] = conn;
    
    conn.on('data', handleIncomingData);
    
    conn.on('open', () => {
        console.log('Peer connection opened:', conn.peer);
        notyf.success("Connected to host");
    });
    
    conn.on('close', () => {
        delete connections[conn.peer];
        console.log('Peer disconnected:', conn.peer);
    });
}

// Add video streaming functions
async function setupHostVideo(file) {
    const mediaSource = new MediaSource();
    videoPlayer.src = URL.createObjectURL(mediaSource);
    
    mediaSource.addEventListener('sourceopen', async () => {
        const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
        
        let offset = 0;
        while (offset < file.size) {
            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            const arrayBuffer = await chunk.arrayBuffer();
            
            // Add to local video
            if (!sourceBuffer.updating) {
                sourceBuffer.appendBuffer(arrayBuffer);
            }
            
            // Send to all peers
            Object.values(connections).forEach(conn => {
                if (conn.open) {
                    conn.send({
                        type: 'video-chunk',
                        data: arrayBuffer,
                        offset: offset,
                        total: file.size
                    });
                }
            });
            
            offset += CHUNK_SIZE;
            await new Promise(resolve => setTimeout(resolve, 50)); // Throttle sending
        }
    });
}

function handleIncomingData(data) {
    if (data.type === 'video-chunk') {
        if (!videoPlayer.mediaSource) {
            videoPlayer.mediaSource = new MediaSource();
            videoPlayer.src = URL.createObjectURL(videoPlayer.mediaSource);
            
            videoPlayer.mediaSource.addEventListener('sourceopen', () => {
                videoPlayer.sourceBuffer = videoPlayer.mediaSource.addSourceBuffer(
                    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"'
                );
                processBufferedChunks();
            });
        }
        
        if (videoPlayer.sourceBuffer && !videoPlayer.sourceBuffer.updating) {
            videoPlayer.sourceBuffer.appendBuffer(data.data);
        } else {
            streamBuffer.push(data);
        }
    }
}

function processBufferedChunks() {
    while (streamBuffer.length > 0 && !videoPlayer.sourceBuffer.updating) {
        const chunk = streamBuffer.shift();
        videoPlayer.sourceBuffer.appendBuffer(chunk.data);
    }
}
// Modify the room creation click handler
const originalCreateHandler = document.getElementById("roomCreateButton").onclick;
document.getElementById("roomCreateButton").onclick = async function(e) {
    const roomName = document.getElementById("roomname").value;
    if (roomName.length === 0 || !document.getElementById("create-username").value) {
        document.getElementById("createRoomText").innerHTML = "Please fill in all the fields";
        return;
    }

    const file = document.getElementById("file-id").files[0];
    if (!file) {
        document.getElementById("createRoomText").innerHTML = "Please select a video file";
        return;
    }

    // Initialize as host
    localStorage.setItem("isHost", "true");
    initializePeer(true);

    // Set up video streaming
    setupHostVideo(file);

    // Continue with original room creation logic
    if (originalCreateHandler) {
        originalCreateHandler.call(this, e);
    }
};

// Modify room join handler
const originalJoinHandler = document.getElementById("roomJoinButton").onclick;
document.getElementById("roomJoinButton").onclick = async function(e) {
    const inputRoomCode = document.getElementById("roomCode").value;
    if (!inputRoomCode || !document.getElementById("join-username").value) {
        document.getElementById("joinRoomText").innerHTML = "Please fill in all the fields";
        return;
    }

    // Initialize as client
    localStorage.setItem("isHost", "false");
    initializePeer(false);

    // Connect to host
    if (localStorage.getItem("hostPeerId")) {
        const conn = peer.connect(localStorage.getItem("hostPeerId"));
        setupConnection(conn);
    }

    // Continue with original join logic
    if (originalJoinHandler) {
        originalJoinHandler.call(this, e);
    }
};

// Modify socket events to handle peer IDs
const originalUserJoinedHandler = socket.listeners('user-joined')[0];
socket.on('user-joined', data => {
    if (data.roomCode === localStorage.getItem("roomCode")) {
        // Handle peer connection if we're not the host
        if (!localStorage.getItem("isHost") && data.hostPeerId) {
            const conn = peer.connect(data.hostPeerId);
            setupConnection(conn);
        }
    }
    // Call original handler
    if (originalUserJoinedHandler) {
        originalUserJoinedHandler(data);
    }
});
