// The HTML5 client of Bub's Brothers.
//
// It does what display/pclient.py does, in a web browser.  The game
// protocol is the same; only the transport differs (see
// common/transport.py and common/html5server.py):
//
//  * the reliable stream (TCP for the other clients) is a WebSocket,
//    with binary frames;
//  * the frames (UDP for the other clients) come over a WebRTC data
//    channel, unordered and without retransmissions.  The WebRTC offer,
//    answer and candidates go over the WebSocket, as JSON in text
//    frames.  Until the data channel is open, or if it does not work,
//    the frames come over the WebSocket too ("udp over tcp").

(function () {
'use strict';

var CONFIG = window.BUBBROS_CONFIG || {};

var MSG_WELCOME = 'Welcome to gamesrv.py(3) !\n';
var MSG_INLINE_FRAME = '\\';
var PROTO_VERSION = 3;

var TASKBAR_HEIGHT = 48;
var MAX_SIDE = 4096;            // of an image
var MAX_FILE_SIZE = 64 * 1024 * 1024;
var MAX_FRAME = 1024 * 1024;    // one frame, decompressed
// switch to the WebSocket if the data channel didn't receive at least
// 60% of what the server sent
var UDP_EXPECTED_RATIO = 0.60;
var UDP_PATIENCE = 10;          // seconds, before saying that UDP is late
var KEY_PRESSED = 2, KEY_RELEASED = 3;


// ____________________________________________________________
// Messages (see common/msgstruct.py)

function ascii(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++)
        a[i] = s.charCodeAt(i) & 0xFF;
    return a;
}

function utf8(s) {
    return new TextEncoder().encode(s);
}

function fromUtf8(a) {
    return new TextDecoder('utf-8').decode(a);
}

// message('k', 1, 3): the values are integers or Uint8Arrays
function message(tp) {
    var codes = '', size = 1, i, v;
    for (i = 1; i < arguments.length; i++) {
        v = arguments[i];
        if (v instanceof Uint8Array) {
            codes += v.length + 's';
            size += v.length;
        } else if (v >= 0 && v < 256) {
            codes += 'B';
            size += 1;
        } else {
            codes += 'l';
            size += 4;
        }
    }
    var buf = new Uint8Array(1 + codes.length + size);
    var view = new DataView(buf.buffer);
    var pos = 0;
    buf[pos++] = codes.length;
    buf.set(ascii(codes), pos);
    pos += codes.length;
    buf[pos++] = tp.charCodeAt(0);
    for (i = 1; i < arguments.length; i++) {
        v = arguments[i];
        if (v instanceof Uint8Array) {
            buf.set(v, pos);
            pos += v.length;
        } else if (v >= 0 && v < 256) {
            buf[pos++] = v;
        } else {
            view.setInt32(pos, v);
            pos += 4;
        }
    }
    return buf;
}

// Returns {values: [type, value...], end: position} or null if the
// message that starts at 'pos' is not complete.
function decodeMessage(buf, pos) {
    if (pos >= buf.length)
        return null;
    var limit = pos + 1 + buf[pos];
    if (buf.length < limit)
        return null;
    var fields = [], size = 1, n = 0, c, i;
    for (i = pos + 1; i < limit; i++) {
        c = buf[i];
        if (c >= 48 && c <= 57) {
            n = n * 10 + (c - 48);
            if (n > 0x7FFFFFFF)
                throw new Error('bad message');
        } else if (c === 115) {         // 's'
            fields.push(n);
            size += n;
            n = 0;
        } else if (c === 66) {          // 'B'
            fields.push(-1);
            size += 1;
        } else if (c === 108) {         // 'l'
            fields.push(-4);
            size += 4;
        } else {
            throw new Error('bad message');
        }
    }
    var end = limit + size;
    if (buf.length < end) {
        if (size > 16 * 1024 * 1024)
            throw new Error('message too large');
        return null;
    }
    var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var p = limit;
    var values = [String.fromCharCode(buf[p++])];
    for (i = 0; i < fields.length; i++) {
        n = fields[i];
        if (n === -1) {
            values.push(buf[p++]);
        } else if (n === -4) {
            values.push(view.getInt32(p));
            p += 4;
        } else {
            values.push(buf.slice(p, p + n));
            p += n;
        }
    }
    return {values: values, end: end};
}


// ____________________________________________________________
// Files sent by the server, in blocks (see display/caching.py).
// Nothing is kept from one visit to the next: the browser has no copy
// of the game's files, so every block is asked for.

function DataFile(fileid) {
    this.fileid = fileid;
    this.blocks = {};       // {position: Uint8Array}
    this.pending = [];      // [position] or [null, callback]
}

DataFile.prototype.serverMd5 = function (position, length) {
    this.pending.push([position]);
    send(message('M', this.fileid, position, length));  // CMSG_DATA_REQUEST
};

DataFile.prototype.serverPatch = function (position, data) {
    this.blocks[position] = data;
    for (var i = 0; i < this.pending.length; i++) {
        if (this.pending[i][0] === position) {
            this.pending.splice(i, 1);
            while (this.pending.length && this.pending[0][0] === null)
                this.pending.shift()[1](this);
            break;
        }
    }
};

DataFile.prototype.whenReady = function (callback) {
    if (this.pending.length)
        this.pending.push([null, callback]);
    else
        callback(this);
};

DataFile.prototype.extent = function () {
    var end = 0, total = 0;
    for (var position in this.blocks) {
        var length = this.blocks[position].length;
        total += length;
        end = Math.max(end, +position + length);
    }
    return {end: end, total: total};
};

// all the blocks from the start to the end of the file are there
DataFile.prototype.complete = function () {
    var e = this.extent();
    return !this.pending.length && e.end > 0 && e.total >= e.end;
};

DataFile.prototype.read = function () {
    var result = new Uint8Array(this.extent().end);
    for (var position in this.blocks)
        result.set(this.blocks[position], +position);
    return result;
};


// ____________________________________________________________
// State

var canvas, ctx, statusline;
var ws = null;
var inbuf = new Uint8Array(0);
var welcomed = false;
var gameident = '';
var width = 0, height = 0;
var initlevel = 0;

var playing = {};           // {player id: 0, 1, or 'l' for local}
var keys = {};              // {key name: {num, icons}}
var keycodes = {};          // {"keysym/event": {pid, msg}}
var lastKeyEvent = [null, 0];
var bitmaps = {};           // {bmpcode: {data, colorkey, image}}
var icons = {};             // {icocode: Icon}
var playericons = {};       // {player id: Icon}
var fileids = {};           // {fileid: DataFile}
var frame = null;           // the sprites to draw: 6 bytes each
var dirty = true;

var taskbarmode = 0, taskbarfree = 0, taskbartimeout = null;
var keydefinition = null;   // or {pid, df: {key name: keysym}}

// frames
var pc = null, dc = null;
var dcOpen = false, serverReady = false;
var udpMode = false;        // the frames come over the data channel
var udpLow = null;
var udpBytes = 0;
var inlineInflater = null;
var dynThreads = [];
var dynNoRepeat = null;

// sounds
var audio = null;
var aout = null;
var soundEnabled = true, musicEnabled = true;
var sounds = {};            // {sample code: AudioBuffer}
var playingsounds = {};
var music = null;           // {loopFrom, codes, index, track, gain}

var names = {};             // {player id: name}

function now() {
    return Date.now() / 1000;
}

function status(text) {
    if (statusline)
        statusline.textContent = text;
}

// What happens with the connection and the music goes to the console
// of the browser, for who wants to know how the game is connected.
function log(text) {
    console.log('[bubbros] ' + text);
}

function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(data);
}

function sendSignaling(obj) {
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(obj));
}


// ____________________________________________________________
// Images

function getIcon(code) {
    var ico = icons[code];
    if (!ico)
        ico = icons[code] = {bmpcode: null, rect: null, w: 0, h: 0,
                             alpha: 255, clip: null};
    return ico;
}

// A .ppm image (see common/pixmap.py) as a canvas, the color 'colorkey'
// being transparent.
function decodePixmap(data, colorkey) {
    var pos = 0;
    function line() {
        var start = pos;
        while (pos < data.length && data[pos] !== 10)
            pos++;
        var s = String.fromCharCode.apply(null, data.subarray(start, pos));
        pos++;
        return s.trim();
    }
    if (line() !== 'P6')
        throw new Error('not a PPM image');
    var l;
    do {
        l = line();
    } while (l.charAt(0) === '#');
    var wh = l.split(/\s+/);
    var w = parseInt(wh[0], 10), h = parseInt(wh[1], 10);
    if (line() !== '255')
        throw new Error('not an 8-bit PPM image');
    if (!(w > 0 && w <= MAX_SIDE && h > 0 && h <= MAX_SIDE) ||
        data.length - pos < 3 * w * h)
        throw new Error('bad PPM image size');
    var ckr = -1, ckg = -1, ckb = -1;
    if (colorkey !== undefined && colorkey !== null) {
        if (colorkey < 0) {     // the color of the first pixel
            ckr = data[pos]; ckg = data[pos + 1]; ckb = data[pos + 2];
        } else {
            ckr = (colorkey >> 16) & 0xFF;
            ckg = (colorkey >> 8) & 0xFF;
            ckb = colorkey & 0xFF;
        }
    }
    var image = document.createElement('canvas');
    image.width = w;
    image.height = h;
    var ictx = image.getContext('2d');
    var pixels = ictx.createImageData(w, h);
    var p = pixels.data, r, g, b;
    for (var i = 0, n = w * h; i < n; i++) {
        r = data[pos++]; g = data[pos++]; b = data[pos++];
        p[4 * i] = r;
        p[4 * i + 1] = g;
        p[4 * i + 2] = b;
        p[4 * i + 3] = (r === ckr && g === ckg && b === ckb) ? 0 : 255;
    }
    ictx.putImageData(pixels, 0, 0);
    return image;
}

// The canvas of a bitmap, or null if its data is not there yet.
function getPixmap(bmpcode) {
    var bmp = bitmaps[bmpcode];
    if (!bmp)
        return null;
    if (bmp.image === undefined) {
        var data = bmp.data;
        try {
            if (data instanceof Uint8Array) {
                data = inflate(data);
            } else {
                if (!data.complete())
                    return null;
                data = data.read();
            }
            bmp.image = decodePixmap(data, bmp.colorkey);
        } catch (e) {
            console.warn('bitmap ' + bmpcode + ': ' + e.message);
            bmp.image = null;
        }
    }
    return bmp.image;
}

// Draws an icon; returns false if it is not defined yet.
function drawIcon(ico, x, y) {
    if (ico.bmpcode === null)
        return false;
    var image = getPixmap(ico.bmpcode);
    if (!image)
        return false;
    var c = ico.clip;
    if (!c) {
        // the rectangle of the icon, clipped to its image
        var x0 = Math.max(0, ico.rect[0]), y0 = Math.max(0, ico.rect[1]);
        var x1 = Math.min(image.width, ico.rect[0] + ico.rect[2]);
        var y1 = Math.min(image.height, ico.rect[1] + ico.rect[3]);
        c = ico.clip = [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
    }
    if (c[2] && c[3]) {
        ctx.globalAlpha = ico.alpha / 255;
        ctx.drawImage(image, c[0], c[1], c[2], c[3], x, y, c[2], c[3]);
    }
    return true;
}


// ____________________________________________________________
// Frames

// The frames that come over the data channel (see dynamic_decompress()
// in display/pclient.py).  Format of a packet:
//    header byte:     0x80 - 0x87    packet from thread 0 - 7
//                  or 0x88 - 0x8F    reset packet from thread 0 - 7
//    previous frame in same thread (1 byte)
//    frame number (1 byte)
// Each thread is a zlib stream, so that a frame is compressed relative
// to older ones; with several threads, a lost packet only loses a few
// frames.
function resetDynamicDecompress() {
    dynThreads = [];
    for (var i = 0; i < 8; i++)
        dynThreads.push({inflater: null, last: null, data: null});
    dynNoRepeat = null;
}
resetDynamicDecompress();

function dynamicDecompress(packet) {
    var thread = dynThreads[packet[0] & 7];
    var prevframe = packet[1], thisframe = packet[2];
    var d;
    if (packet[0] >= 0x88) {
        // reset
        if (prevframe !== thisframe) {
            // sync point from a previous frame: the stream starts in
            // the state that follows the data of that frame
            var t = null;
            for (var i = 0; i < 8; i++)
                if (dynThreads[i].last === prevframe) {
                    t = dynThreads[i];
                    break;
                }
            if (!t)
                return null;    // lost
            d = new Inflater(false);
            d.prime(t.data);
        } else {
            d = new Inflater(true);     // global sync point
        }
        thread.inflater = d;
    } else if (prevframe !== thread.last || !thread.inflater) {
        return null;    // lost
    } else {
        d = thread.inflater;
    }
    try {
        var framedata = d.feed(packet.subarray(3), MAX_FRAME);
        thread.last = thisframe;
        thread.data = framedata;
        if (thisframe === dynNoRepeat)
            return null;
        dynNoRepeat = thisframe;
        return framedata;
    } catch (e) {
        thread.inflater = null;
        return null;
    }
}

function onDatagram(packet) {
    udpBytes += packet.length;
    if (!udpMode)
        return;
    if (packet.length > 3 && packet[0] >= 0x80 && packet[0] < 0x90)
        packet = dynamicDecompress(packet);
    if (packet)
        updateSprites(packet);
}

function updateSprites(data) {
    var currentsounds = {};
    var base = 0;
    // first the sounds: code, left volume, right volume, 0xFFFF
    while (base + 6 <= data.length &&
           data[base + 4] === 0xFF && data[base + 5] === 0xFF) {
        var key = (data[base] << 8) | data[base + 1];
        var snd = sounds[key];
        if (snd) {
            var n = playingsounds[key];
            if (n) {
                currentsounds[key] = n - 1;
            } else {
                playSound(snd, data[base + 2] / 255, data[base + 3] / 255);
                currentsounds[key] = 4;
            }
        }
        base += 6;
    }
    playingsounds = currentsounds;
    // then the sprites: x, y, icon code
    frame = data.subarray(base);
    dirty = true;
}

function startUdpOverTcp(why) {
    log('frames: over TCP, in WebSocket (' + why + ')');
    udpMode = false;
    udpLow = null;
    inlineInflater = new Inflater(true);
    send(message('<', ascii(MSG_INLINE_FRAME)));    // CMSG_UDP_PORT
}

function startUdp() {
    // called when both ends of the data channel are open
    if (!dcOpen || !serverReady || udpMode || initlevel < 1)
        return;
    udpMode = true;
    udpLow = 0;
    resetDynamicDecompress();
    send(message('<', 1));          // CMSG_UDP_PORT; no real port number
    log('frames: over UDP, in WebRTC data channel');
    logUdpRoute();
}

// Which UDP addresses the data channel uses, if the browser tells.
function logUdpRoute() {
    function show(local, remote) {
        function address(c) {
            return (c.address || c.ip || '?') + ':' + c.port;
        }
        log('UDP: connected to ' + address(remote) + ' (' +
            (remote.candidateType || remote.type || '?') + ') from ' +
            address(local) + ' (' +
            (local.candidateType || local.type || '?') + ')');
    }
    try {
        var ice = pc.sctp && pc.sctp.transport &&
            pc.sctp.transport.iceTransport;
        var pair = ice && ice.getSelectedCandidatePair &&
            ice.getSelectedCandidatePair();
        if (pair && pair.local && pair.remote)
            return show(pair.local, pair.remote);
        pc.getStats().then(function (stats) {
            var found = null;
            stats.forEach(function (r) {
                if (r.type === 'candidate-pair' && r.state === 'succeeded' &&
                    (r.nominated || r.selected) && !found)
                    found = r;
            });
            if (found)
                show(stats.get(found.localCandidateId),
                     stats.get(found.remoteCandidateId));
        }).catch(function () { });
    } catch (e) {
    }
}

function udpFailed(why) {
    dcOpen = false;
    if (udpMode)
        startUdpOverTcp('UDP failed: ' + why);
    else if (ws)
        log('UDP: not available (' + why + ')');
}

function startWebRTC() {
    if (!window.RTCPeerConnection || CONFIG.udp === false) {
        log('UDP: not used (' + (CONFIG.udp === false ? 'switched off' :
                                 'no WebRTC in this browser') + ')');
        return;
    }
    log('UDP: opening a WebRTC data channel...');
    setTimeout(function () {
        if (ws && !udpMode && !(dcOpen && serverReady))
            log('UDP: the WebRTC data channel is still not open after ' +
                UDP_PATIENCE + ' seconds, staying on TCP');
    }, UDP_PATIENCE * 1000);
    var offerSent = false, candidates = [];
    try {
        var servers = (CONFIG.iceServers || []).map(function (url) {
            return {urls: url};
        });
        pc = new RTCPeerConnection({iceServers: servers});
        dc = pc.createDataChannel('frames', {ordered: false,
                                             maxRetransmits: 0});
    } catch (e) {
        console.warn('WebRTC: ' + e.message);
        pc = dc = null;
        return;
    }
    dc.binaryType = 'arraybuffer';
    dc.onopen = function () {
        dcOpen = true;
        log('UDP: WebRTC data channel open');
        startUdp();
    };
    dc.onclose = function () {
        udpFailed('data channel closed');
    };
    dc.onmessage = function (e) {
        if (e.data instanceof ArrayBuffer)
            onDatagram(new Uint8Array(e.data));
    };
    pc.onicecandidate = function (e) {
        // The server is the side that can be reached: it does not need
        // our candidates to find us, and it cannot use the ".local"
        // names that browsers give instead of local addresses.
        if (!e.candidate || !e.candidate.candidate ||
            e.candidate.candidate.indexOf('.local') >= 0)
            return;
        var c = {type: 'candidate', candidate: e.candidate.candidate,
                 mid: e.candidate.sdpMid || ''};
        if (offerSent)
            sendSignaling(c);
        else
            candidates.push(c);
    };
    pc.onconnectionstatechange = function () {
        if (pc && pc.connectionState === 'failed')
            udpFailed('connection failed');
    };
    pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer);
    }).then(function () {
        sendSignaling({type: 'offer', sdp: pc.localDescription.sdp});
        offerSent = true;
        candidates.forEach(sendSignaling);
    }).catch(function (e) {
        console.warn('WebRTC: ' + e.message);
    });
}

function onSignaling(text) {
    var msg;
    try {
        msg = JSON.parse(text);
    } catch (e) {
        return;
    }
    if (msg.type === 'answer' && pc) {
        pc.setRemoteDescription({type: 'answer', sdp: msg.sdp}).catch(
            function (e) { console.warn('WebRTC: ' + e.message); });
    } else if (msg.type === 'ready') {
        serverReady = true;
        startUdp();
    }
}


// ____________________________________________________________
// Sounds and music

function initAudio() {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext || (!soundEnabled && !musicEnabled))
        return;
    try {
        audio = new AudioContext();
        audio.onstatechange = function () {
            if (music && !music.track)
                startTrack();
        };
        aout = makeAudioOut();
    } catch (e) {
        audio = null;
    }
}

var CLIP_KNEE = 0.5;        // below this, unchanged
var CLIP_RANGE = 4;         // the input the curve covers, -4..4

function softClip(x) {
    var a = Math.abs(x);
    if (a <= CLIP_KNEE)
        return x;
    var y = CLIP_KNEE + (1 - CLIP_KNEE) * Math.tanh((a - CLIP_KNEE) /
                                                    (1 - CLIP_KNEE));
    return x < 0 ? -y : y;
}

function makeAudioOut() {
    // a WaveShaper maps -1..1 to its curve: scale the input down first
    var input = audio.createGain();
    input.gain.value = 1 / CLIP_RANGE;
    var shaper = audio.createWaveShaper();
    var n = 4097, curve = new Float32Array(n);
    for (var i = 0; i < n; i++)
        curve[i] = softClip((2 * i / (n - 1) - 1) * CLIP_RANGE);
    shaper.curve = curve;
    shaper.oversample = '4x';
    input.connect(shaper);
    shaper.connect(audio.destination);
    return input;
}

function logAudio() {
    log('audio: sounds ' + (audio && soundEnabled ? 'on' : 'off') +
        ', music ' + (audio && musicEnabled ? 'on' : 'off') +
        (audio ? '' : ' (no AudioContext)'));
}

function resumeAudio() {
    // browsers only start playing sounds after a key or a click
    if (audio && audio.state === 'suspended')
        audio.resume();
    if (audio && music && !music.track)
        startTrack();
}

function decodeSample(code, data) {
    if (!audio)
        return;
    var copy = data.buffer.slice(data.byteOffset,
                                 data.byteOffset + data.byteLength);
    audio.decodeAudioData(copy, function (buffer) {
        sounds[code] = buffer;
    }, function () {
        console.warn('cannot decode sample ' + code);
    });
}

function playSound(buffer, lvolume, rvolume) {
    if (!audio || audio.state !== 'running')
        return;
    var source = audio.createBufferSource();
    var merger = audio.createChannelMerger(2);
    var left = audio.createGain(), right = audio.createGain();
    source.buffer = buffer;
    left.gain.value = lvolume;
    right.gain.value = rvolume;
    source.connect(left);
    source.connect(right);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(aout);
    source.start();
}

// Music.  The server has a list of music files to play one after the
// other, the last ones in a loop (MSG_PLAY_MUSIC).  They are .wav files
// that the server sends in blocks of one second, one block per second
// (they are large: the main track is 10 megabytes).  As in the other
// clients, a file is played while it arrives.

var MUSIC_VOLUME = 0.7;

// The format of a .wav file, from its first block: {channels, rate,
// bits, align, start, end} or null.
function parseWav(data) {
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    function tag(p) {
        return String.fromCharCode(data[p], data[p + 1], data[p + 2],
                                   data[p + 3]);
    }
    if (data.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
        return null;
    var fmt = null;
    for (var p = 12; p + 8 <= data.length;) {
        var size = view.getUint32(p + 4, true);
        if (tag(p) === 'fmt ' && p + 24 <= data.length) {
            fmt = {channels: view.getUint16(p + 10, true),
                   rate: view.getUint32(p + 12, true),
                   bits: view.getUint16(p + 22, true)};
            if (view.getUint16(p + 8, true) !== 1 || !fmt.channels ||
                fmt.channels > 2 || (fmt.bits !== 8 && fmt.bits !== 16) ||
                !(fmt.rate >= 3000 && fmt.rate <= 192000))
                return null;        // not plain PCM
            fmt.align = fmt.channels * fmt.bits / 8;
        } else if (tag(p) === 'data') {
            if (!fmt)
                return null;
            fmt.start = p + 8;
            fmt.end = fmt.start + size;
            return fmt;
        }
        p += 8 + size + (size & 1);
    }
    return null;
}

function WavTrack(fileid, onended) {
    this.fileid = fileid;
    this.onended = onended;
    this.file = getFile(fileid);
    this.fmt = null;
    this.pos = 0;           // next byte of the file to play
    this.nextTime = 0;      // when to play it, in the time of 'audio'
    this.started = false;
    this.sources = [];
    this.timer = null;
    this.stopped = false;
    this.pump();
}

// The bytes of the file that are there from 'pos' on, at most 'max'.
WavTrack.prototype.available = function (pos, max) {
    var blocks = this.file.blocks;
    for (var position in blocks) {
        var start = +position, block = blocks[position];
        if (start <= pos && pos < start + block.length)
            return block.subarray(pos - start,
                                  Math.min(block.length, pos - start + max));
    }
    return null;
};

// Where the music ends in the file, or null if not known yet.  The
// server sends the first block, then the last one, then the others.
WavTrack.prototype.end = function () {
    if (Object.keys(this.file.blocks).length < 2 &&
        this.file.pending.length)
        return null;
    return Math.min(this.fmt.end, this.file.extent().end);
};

WavTrack.prototype.buffered = function () {
    // seconds of music that are there from this.pos on
    var bytes = 0, chunk;
    while (bytes < 4 * this.fmt.rate * this.fmt.align &&
           (chunk = this.available(this.pos + bytes, 0x100000)))
        bytes += chunk.length;
    return bytes / (this.fmt.rate * this.fmt.align);
};

WavTrack.prototype.pump = function () {
    var self = this, fmt = this.fmt;
    if (this.stopped)
        return;
    if (!fmt) {
        var head = this.file.blocks[0];
        if (!head)
            return;         // called again when the first block arrives
        fmt = this.fmt = parseWav(head);
        if (!fmt) {
            console.warn('music ' + this.fileid + ': unknown format');
            this.stop();
            return this.onended();
        }
        this.pos = fmt.start;
        this.timer = setInterval(function () { self.pump(); }, 200);
    }
    var end = this.end();
    var t = audio.currentTime;
    if (!this.started) {
        // wait for two seconds of music, as the blocks only come at the
        // speed they are played
        if ((end === null || this.pos < end) &&
            this.buffered() < Math.min(2, end === null ? 2 :
                (end - this.pos) / (fmt.rate * fmt.align)))
            return;
        this.started = true;
        this.nextTime = t + 0.05;
    }
    // drop the sources that have finished
    while (this.sources.length && this.sources[0].endTime < t)
        this.sources.shift();
    while (this.nextTime < t + 1.5) {
        if (end !== null && this.pos >= end) {
            // the end: the next track starts when this one is done
            clearInterval(this.timer);
            this.timer = setTimeout(function () {
                if (!self.stopped) {
                    self.stopped = true;
                    self.onended();
                }
            }, Math.max(0, (this.nextTime - t) * 1000));
            return;
        }
        var max = fmt.rate * fmt.align;         // one second
        if (end !== null)
            max = Math.min(max, end - this.pos);
        var chunk = this.available(this.pos, max);
        var frames = chunk ? Math.floor(chunk.length / fmt.align) : 0;
        if (!frames) {
            // nothing more yet: a silence until more blocks arrive
            this.started = false;
            return;
        }
        var buffer = audio.createBuffer(fmt.channels, frames, fmt.rate);
        for (var c = 0; c < fmt.channels; c++) {
            var out = buffer.getChannelData(c), i, p;
            if (fmt.bits === 8) {
                for (i = 0, p = c; i < frames; i++, p += fmt.align)
                    out[i] = (chunk[p] - 128) / 128;
            } else {
                for (i = 0, p = 2 * c; i < frames; i++, p += fmt.align)
                    out[i] = ((chunk[p] | (chunk[p + 1] << 8)) << 16 >> 16)
                        / 32768;
            }
        }
        var source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(music.gain);
        if (this.nextTime < t)
            this.nextTime = t;
        source.start(this.nextTime);
        this.nextTime += frames / fmt.rate;
        source.endTime = this.nextTime;
        this.sources.push(source);
        this.pos += frames * fmt.align;
    }
};

WavTrack.prototype.stop = function () {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.timer);
    for (var i = 0; i < this.sources.length; i++) {
        try {
            this.sources[i].stop();
            this.sources[i].disconnect();
        } catch (e) {
        }
    }
    this.sources = [];
};

function playMusics(loopFrom, codes) {
    stopMusic();
    if (!audio || !codes.length)
        return;
    music = {loopFrom: loopFrom, codes: codes, index: 0, track: null,
             gain: audio.createGain()};
    music.gain.gain.value = MUSIC_VOLUME;
    music.gain.connect(aout);
    startTrack();
}

function startTrack() {
    var m = music;
    if (!m || m.track)
        return;
    if (audio.state !== 'running')
        return;     // called again by resumeAudio(), after a key or click
    if (m.index >= m.codes.length) {
        m.index = m.loopFrom;
        if (m.index >= m.codes.length)
            return stopMusic();     // nothing to loop
    }
    var fileid = m.codes[m.index];
    function ended() {
        if (music !== m)
            return;
        m.track = null;
        m.index++;
        startTrack();
    }
    var f = getFile(fileid);
    log('music: playing ' + (f.name || 'file ' + fileid) +
        (f.complete() ? ' (wav, cached)' : ' (wav, downloading)'));
    m.track = new WavTrack(fileid, ended);
}

function pumpMusic() {
    // more data has arrived
    if (music && music.track)
        music.track.pump();
}

function stopMusic() {
    var m = music;
    music = null;
    if (m) {
        if (m.track)
            m.track.stop();
        try {
            m.gain.disconnect();
        } catch (e) {
        }
    }
}

function fadeoutMusic(milliseconds) {
    var m = music;
    if (!m)
        return;
    var t = audio.currentTime;
    m.gain.gain.setValueAtTime(m.gain.gain.value, t);
    m.gain.gain.linearRampToValueAtTime(0, t + milliseconds / 1000);
    setTimeout(function () {
        if (music === m)
            stopMusic();
    }, milliseconds);
}


// ____________________________________________________________
// The task bar: the dragons at the bottom of the window.  Click on one
// and press four keys to play with it; click on it again to leave.

function nextKeyName() {
    var best = null;
    for (var keyname in keys) {
        var k = keys[keyname];
        if (!(keyname in keydefinition.df) && k.icons.length &&
            (best === null || k.num < keys[best].num))
            best = keyname;
    }
    return best;
}

function getTaskbar() {
    var y0 = height - TASKBAR_HEIGHT;
    var iconlist = [];
    var f = 1.5 * now();
    f = f - Math.floor(f);
    var pids = Object.keys(playericons).map(Number).sort(function (a, b) {
        return a - b;
    });
    var xpos = 0, i, id, ico, y;
    for (i = 0; i < pids.length; i++) {
        id = pids[i];
        ico = playericons[id];
        if (playing[id] !== 'l') {
            xpos += Math.floor(ico.w * 5 / 3);
            if (!playing[id]) {
                var x = xpos - ico.w;
                y = height - ico.h;
                if (keydefinition && id === keydefinition.pid) {
                    var keyicons = keys[nextKeyName()].icons;
                    ico = keyicons[(Math.floor(f * keyicons.length) +
                                    keyicons.length - 1) % keyicons.length];
                    y = y0 + Math.floor((TASKBAR_HEIGHT - ico.h) / 2);
                }
                iconlist.push({x: x, y: y, ico: ico, id: id});
            }
        }
    }
    f = f * (1.0 - f) * 4.0;
    xpos = width;
    for (i = pids.length - 1; i >= 0; i--) {
        id = pids[i];
        ico = playericons[id];
        if (playing[id] === 'l') {
            xpos -= Math.floor(ico.w * 5 / 3);
            var dy = TASKBAR_HEIGHT - ico.h - 1;
            y = height - ico.h - Math.floor(dy * f);
            iconlist.push({x: xpos, y: y, ico: ico, id: id});
        }
    }
    return {y0: y0, icons: iconlist};
}

function clicTaskbar(cx, cy) {
    var tb = getTaskbar();
    if (cy >= tb.y0) {
        for (var i = 0; i < tb.icons.length; i++) {
            var t = tb.icons[i];
            if (t.x <= cx && cx < t.x + t.ico.w)
                return t.id;
        }
    }
    return null;
}

function drawTaskbar() {
    var tb = getTaskbar();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#000080';
    ctx.fillRect(0, tb.y0, width, TASKBAR_HEIGHT);
    for (var i = 0; i < tb.icons.length; i++)
        drawIcon(tb.icons[i].ico, tb.icons[i].x, tb.icons[i].y);
    ctx.globalAlpha = 1;
}

function hasLocalPlayer() {
    for (var id in playing)
        if (playing[id] === 'l')
            return true;
    return false;
}

function setTaskbar(nmode) {
    taskbartimeout = null;
    if (taskbarfree) {
        taskbarmode = (nmode || !hasLocalPlayer() || keydefinition !== null)
            ? 1 : 0;
        if (nmode)
            taskbartimeout = now() + 5.0;
        dirty = true;
    }
}

function defineKey(keysym) {
    var df = keydefinition.df;
    for (var k in df)
        if (df[k] === keysym)
            return;
    df[nextKeyName()] = keysym;
    if (nextKeyName() !== null)
        return;
    var pid = keydefinition.pid;
    keydefinition = null;
    send(message('+', pid));        // CMSG_ADD_PLAYER
    for (var keyname in keys) {
        var event = KEY_PRESSED, name = keyname;
        if (name.charAt(0) === '-') {
            event = KEY_RELEASED;
            name = name.substring(1);
        }
        if (name in df)
            keycodes[df[name] + '/' + event] = {
                pid: pid, msg: message('k', pid, keys[keyname].num)};
    }
}

function onKey(e, event) {
    if (e.ctrlKey && e.code !== 'ControlLeft' && e.code !== 'ControlRight')
        return;     // a shortcut of the browser
    if (e.altKey && e.code !== 'AltLeft' && e.code !== 'AltRight')
        return;
    resumeAudio();
    var keysym = e.code || ('key' + e.keyCode);
    var code = keycodes[keysym + '/' + event];
    if (code && playing[code.pid] === 'l') {
        e.preventDefault();
        // A key that is held is sent again now and then, not at every
        // auto-repeat: the server may have released it (Time Machine).
        if (e.repeat && code === lastKeyEvent[0] &&
            now() - lastKeyEvent[1] < 0.77)
            return;
        lastKeyEvent = [code, now()];
        send(code.msg);
    } else if (keydefinition && event === KEY_PRESSED) {
        e.preventDefault();
        if (!e.repeat)
            defineKey(keysym);
        dirty = true;
    } else if (keycodes[keysym + '/' + KEY_PRESSED]) {
        e.preventDefault();     // e.g. no scrolling with the arrow keys
    }
}

function playfieldXY(e) {
    var rect = canvas.getBoundingClientRect();
    return [Math.floor((e.clientX - rect.left) * width / rect.width),
            Math.floor((e.clientY - rect.top) * height / rect.height)];
}

function onMouseMove(e) {
    if (!width)
        return;
    var xy = playfieldXY(e);
    setTaskbar(xy[1] >= height - 2 * TASKBAR_HEIGHT ? 1 : 0);
}

function onMouseDown(e) {
    if (!width)
        return;
    resumeAudio();
    var xy = playfieldXY(e);
    setTaskbar(1);
    keydefinition = null;
    var id = clicTaskbar(xy[0], xy[1]);
    if (id !== null) {
        if (playing[id] === 'l')
            send(message('-', id));         // CMSG_REMOVE_PLAYER
        else
            keydefinition = {pid: id, df: {}};
    }
    setTaskbar(1);
    e.preventDefault();
    canvas.focus();
}


// ____________________________________________________________
// Drawing

function draw() {
    window.requestAnimationFrame(draw);
    if (!width)
        return;
    if (taskbartimeout !== null && now() > taskbartimeout)
        setTaskbar(0);
    if (!dirty && !taskbarmode)
        return;
    dirty = false;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    if (frame) {
        var f = frame, x, y, code, ico;
        for (var j = 0; j + 6 <= f.length; j += 6) {
            x = (f[j] << 8) | f[j + 1];
            y = (f[j + 2] << 8) | f[j + 3];
            code = (f[j + 4] << 8) | f[j + 5];
            if (x & 0x8000) x -= 0x10000;
            if (y & 0x8000) y -= 0x10000;
            ico = icons[code];
            // sprites with an icon that is not defined yet are ignored
            if (ico && !drawIcon(ico, x, y))
                dirty = true;       // try again: its image may come
        }
        ctx.globalAlpha = 1;
    }
    if (taskbarmode)
        drawTaskbar();
}


// ____________________________________________________________
// Messages from the server

function sendPlayerNames() {
    for (var id in playing)
        if (playing[id] === 'l' && names[id])
            send(message('n', +id, utf8(names[id])));   // CMSG_PLAYER_NAME
}

function getFile(fileid) {
    var f = fileids[fileid];
    if (!f)
        f = fileids[fileid] = new DataFile(fileid);
    return f;
}

function validRange(position, length) {
    return position >= 0 && length >= 0 &&
        position + length <= MAX_FILE_SIZE;
}

var MESSAGES = {

    'p': function (w, h, backcolor, ident) {    // MSG_DEF_PLAYFIELD
        if (!(w > 0 && w <= MAX_SIDE && h > 0 && h <= MAX_SIDE))
            throw new Error('bad playfield size');
        width = w;
        height = h;
        canvas.width = w;
        canvas.height = h;
        frame = null;
        if (ident) {
            gameident = fromUtf8(ident);
            document.title = gameident;
        }
        status('');
        if (audio && soundEnabled)
            send(message('s'));                 // CMSG_ENABLE_SOUND
        send(message('g'));                     // CMSG_PING
        taskbarmode = 0;
        taskbarfree = 0;
        taskbartimeout = null;
        keydefinition = null;
        dirty = true;
        resize();
    },

    'k': function (name, num) {                 // MSG_DEF_KEY
        var list = [];
        for (var i = 2; i < arguments.length; i++)
            list.push(getIcon(arguments[i]));
        keys[fromUtf8(name)] = {num: num, icons: list};
    },

    'r': function (bmpcode, icocode, x, y, w, h, alpha) {   // MSG_DEF_ICON
        var ico = getIcon(icocode);
        ico.bmpcode = bmpcode;
        ico.rect = [x, y, w, h];
        ico.w = w;
        ico.h = h;
        ico.clip = null;
        if (alpha !== undefined && alpha < 255)
            ico.alpha = alpha;
        dirty = true;
    },

    'm': function (bmpcode, data, colorkey) {   // MSG_DEF_BITMAP
        if (!(data instanceof Uint8Array))      // a file id, not inline data
            data = getFile(data);
        bitmaps[bmpcode] = {data: data, colorkey: colorkey};
        dirty = true;
    },

    'w': function (smpcode, data) {             // MSG_DEF_SAMPLE
        if (data instanceof Uint8Array) {       // inline data, else a file id
            decodeSample(smpcode, inflate(data));
        } else {
            getFile(data).whenReady(function (f) {
                decodeSample(smpcode, f.read());
            });
        }
    },

    'z': function (fileid, position, data) {    // MSG_PATCH_FILE
        if (!validRange(position, data.length))
            return;
        getFile(fileid).serverPatch(position, data);
        dirty = true;
        pumpMusic();
    },

    'P': function (fileid, position, data) {    // MSG_ZPATCH_FILE
        MESSAGES.z(fileid, position, inflate(data));
    },

    'M': function (fileid, filename, position, length) {    // MSG_MD5_FILE
        if (!validRange(position, length))
            return;
        getFile(fileid).name = fromUtf8(filename);
        getFile(fileid).serverMd5(position, length);
    },

    'Z': function (loopFrom) {                  // MSG_PLAY_MUSIC
        var codes = Array.prototype.slice.call(arguments, 1);
        playMusics(loopFrom, codes);
    },

    'f': function (time) {                      // MSG_FADEOUT
        fadeoutMusic(time);
    },

    '+': function (id, local) {                 // MSG_PLAYER_JOIN
        if (local) {
            playing[id] = 'l';
            setTaskbar(0);
            sendPlayerNames();
        } else {
            playing[id] = 1;
        }
        dirty = true;
    },

    '-': function (id) {                        // MSG_PLAYER_KILL
        playing[id] = 0;
        for (var key in keycodes)
            if (keycodes[key].pid === id)
                delete keycodes[key];
        dirty = true;
    },

    'i': function (pid, icocode) {              // MSG_PLAYER_ICON
        playericons[pid] = getIcon(icocode);
        dirty = true;
    },

    'g': function (udpkbytes) {                 // MSG_PING
        var args = Array.prototype.slice.call(arguments);
        send(message.apply(null, ['G'].concat(args)));      // CMSG_PONG
        if (args.length && udpLow !== null && udpkbytes) {
            if ((udpkbytes * 1024) * UDP_EXPECTED_RATIO > udpBytes) {
                // too many packets were dropped (maybe all of them)
                udpLow++;
                if (udpLow >= 3 && initlevel >= 1) {
                    // third time now -- that's too much
                    startUdpOverTcp('UDP failed: only ' +
                        Math.round(100 * udpBytes / (udpkbytes * 1024)) +
                        '% of the packets arrived');
                }
            } else {
                udpLow = 0;     // enough packets received
            }
        }
    },

    'G': function () {                          // MSG_PONG
        if (initlevel === 0) {
            // start playing.  The frames come over the WebSocket at
            // first, and over the data channel as soon as it is open.
            initlevel = 1;
            startUdpOverTcp(dcOpen && serverReady ? 'for a moment' :
                            pc ? 'until UDP is ready' : 'no UDP');
            if (audio && musicEnabled) {
                send(message('m', 1));          // CMSG_ENABLE_MUSIC
                send(message('g'));             // CMSG_PING
            }
            startUdp();
        } else if (initlevel === 1) {
            if (audio && musicEnabled)
                send(message('m', 2));          // CMSG_ENABLE_MUSIC
            initlevel = 2;
        }
        if (!taskbarfree && !taskbarmode) {
            taskbarfree = 1;
            setTaskbar(1);
        }
    },

    '\\': function (data) {                     // MSG_INLINE_FRAME
        udpBytes += data.length;
        if (udpMode || !inlineInflater)
            return;
        try {
            updateSprites(inlineInflater.feed(data, MAX_FRAME));
        } catch (e) {
            // a lost frame
        }
    },

    '*': function () {                          // MSG_BROADCAST_PORT
        // no broadcast in a browser
    }
};

function concat(a, b) {
    var result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
}

function onStreamData(data) {
    inbuf = inbuf.length ? concat(inbuf, data) : data;
    var pos = 0;
    if (!welcomed) {
        // "Welcome to gamesrv.py(3) !\n" then the name of the game
        if (inbuf.length < MSG_WELCOME.length)
            return;
        for (var i = 0; i < MSG_WELCOME.length; i++)
            if (inbuf[i] !== MSG_WELCOME.charCodeAt(i))
                throw new Error('connected to something not a game server');
        var eol = inbuf.indexOf(10, MSG_WELCOME.length);
        if (eol < 0)
            return;
        gameident = fromUtf8(inbuf.subarray(MSG_WELCOME.length, eol)).trim();
        document.title = gameident;
        pos = eol + 1;
        welcomed = true;
        log('game server: "' + gameident + '", protocol ' + PROTO_VERSION);
        send(message('v', PROTO_VERSION));      // CMSG_PROTO_VERSION
    }
    for (;;) {
        var m = decodeMessage(inbuf, pos);
        if (!m)
            break;      // incomplete message
        pos = m.end;
        var fn = MESSAGES[m.values[0]];
        if (fn)
            fn.apply(null, m.values.slice(1));
    }
    inbuf = inbuf.slice(pos);
}


// ____________________________________________________________
// Start

function resize() {
    // the largest size that fits in the window, whole multiples of the
    // playfield if possible
    if (!width)
        return;
    var availw = window.innerWidth, availh = window.innerHeight;
    if (!document.fullscreenElement) {
        availw -= 16;
        availh -= canvas.getBoundingClientRect().top + window.scrollY + 40;
    }
    var scale = Math.min(availw / width, availh / height);
    if (scale >= 1)
        scale = Math.floor(scale);
    else
        scale = Math.max(scale, 0.25);
    canvas.style.width = Math.round(width * scale) + 'px';
    canvas.style.height = Math.round(height * scale) + 'px';
}

function readOptions() {
    // player names: ?player0=Bub&team0=1&player1=Bob...
    var params = new URLSearchParams(window.location.search);
    for (var id = 0; id < 10; id++) {
        var name = params.get('player' + id);
        if (name) {
            var team = params.get('team' + id);
            if (team && team.length === 1)
                name = name + ' (' + team + ')';
            names[id] = name;
        }
    }
    try {
        soundEnabled = window.localStorage.getItem('bubbros.sound') !== 'no';
        musicEnabled = window.localStorage.getItem('bubbros.music') !== 'no';
    } catch (e) {
    }
    if (params.get('sound') === 'no') soundEnabled = false;
    if (params.get('music') === 'no') musicEnabled = false;
    if (params.get('udp') === 'no') CONFIG.udp = false;
}

function setupLinks() {
    function toggle(id, key, enabled, label) {
        var a = document.getElementById(id);
        if (!a)
            return;
        a.textContent = label + (enabled ? ': on' : ': off');
        a.onclick = function () {
            try {
                window.localStorage.setItem(key, enabled ? 'no' : 'yes');
            } catch (e) {
            }
            window.location.reload();
            return false;
        };
    }
    toggle('sound', 'bubbros.sound', soundEnabled, 'Sounds');
    toggle('music', 'bubbros.music', musicEnabled, 'Music');
    var fs = document.getElementById('fullscreen');
    if (fs)
        fs.onclick = function () {
            if (canvas.requestFullscreen)
                canvas.requestFullscreen();
            canvas.focus();
            return false;
        };
    var np = document.getElementById('names');
    if (np) {
        var query = [];
        for (var id in names)
            query.push('player' + id + '=' + encodeURIComponent(names[id]));
        np.href = 'name.html?' + query.join('&');
    }
}

function connect() {
    var scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    var host = window.location.hostname || '127.0.0.1';
    var port = CONFIG.wsport || window.location.port;
    var url = scheme + '://' + host + ':' + port + '/';
    status('Connecting...');
    log('TCP: connecting to ' + url + ' (WebSocket)');
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
        status('Connected, loading...');
        log('TCP: connected to ' + host + ' port ' + port + ' (WebSocket)');
        startWebRTC();
    };
    ws.onmessage = function (e) {
        if (typeof e.data === 'string') {
            onSignaling(e.data);
            return;
        }
        try {
            onStreamData(new Uint8Array(e.data));
        } catch (err) {
            console.error(err);
            status('Error: ' + err.message);
            ws.close();
        }
    };
    ws.onclose = function (e) {
        log(welcomed ? 'TCP: disconnected (WebSocket closed, code ' +
            e.code + ')' : 'TCP: cannot connect to ' + url);
        if (statusline && statusline.textContent.indexOf('Error') !== 0)
            status(welcomed ? 'Disconnected from the server.  Reload ' +
                   'the page to connect again.'
                   : 'Cannot connect to the game server.');
        stopMusic();
        ws = null;
        if (pc) {
            try { pc.close(); } catch (e) { }
        }
    };
}

function main() {
    canvas = document.getElementById('playfield');
    statusline = document.getElementById('status');
    ctx = canvas.getContext('2d');
    readOptions();
    setupLinks();
    initAudio();
    logAudio();
    window.addEventListener('keydown', function (e) {
        onKey(e, KEY_PRESSED);
    });
    window.addEventListener('keyup', function (e) {
        onKey(e, KEY_RELEASED);
    });
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('resize', resize);
    document.addEventListener('fullscreenchange', resize);
    if (!CONFIG.wsport && !window.location.port) {
        status('No game server is running.');
        return;
    }
    connect();
    window.requestAnimationFrame(draw);
}

// for the tests
window.bubbros = {
    message: message,
    decodeMessage: decodeMessage,
    dynamicDecompress: dynamicDecompress,
    parseWav: parseWav,
    DataFile: DataFile,
    resetDynamicDecompress: resetDynamicDecompress,
    state: function () {
        return {welcomed: welcomed, gameident: gameident, width: width,
                height: height, initlevel: initlevel, udpMode: udpMode,
                udpBytes: udpBytes, dcOpen: dcOpen, serverReady: serverReady,
                sprites: frame ? Math.floor(frame.length / 6) : 0,
                playing: playing, bitmaps: Object.keys(bitmaps).length,
                icons: Object.keys(icons).length,
                sounds: Object.keys(sounds).length,
                playericons: Object.keys(playericons).length,
                taskbarmode: taskbarmode,
                music: music && {index: music.index, codes: music.codes,
                    loopFrom: music.loopFrom,
                    kind: music.track ? 'wav' : null,
                    time: (music.track && music.track.fmt) ?
                        (music.track.pos - music.track.fmt.start) /
                        music.track.fmt.rate : 0},
                audio: audio && audio.state,
                keydefinition: keydefinition && keydefinition.pid};
    }
};

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', main);
else
    main();

})();
