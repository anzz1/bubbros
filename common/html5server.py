"""The server side of the HTML5 client: the "html5" driver.

A web browser cannot open TCP or UDP sockets.  The HTML5 client talks to
the game server with what a browser has instead:

 * a WebSocket carries the reliable stream (the TCP side of the game
   protocol), in binary frames;
 * a WebRTC data channel, unordered and without retransmissions, carries
   the frames (the UDP side).  The WebRTC offer, answer and candidates are
   exchanged over the same WebSocket, as JSON in text frames.

BrowserTransport is the Transport (see transport.py) of such a client,
so the game logic in gamesrv.py does not see any difference.

This module needs two packages that the rest of the game does not:
picows (WebSockets) and aiolibdatachannel (WebRTC data channels); see
html5/setup.py.  Importing it fails with ImportError without them, and
then the game runs as before, with the Java applet as its web client.

Both packages are made for asyncio, and the game server is a select()
loop.  So an asyncio loop runs in its own thread, and wakes up the game
loop by writing to a socket pair.
"""

import sys

try:
    import picows
    import aiolibdatachannel
except ImportError:
    raise
except Exception as e:      # e.g. SyntaxError on an older Python
    raise ImportError("the html5 driver cannot be loaded: %s" % (e,))

import asyncio, json, os, socket, threading
from collections import deque
from errno import EWOULDBLOCK
from io import BytesIO

from msgstruct import PORTS
from transport import Transport, error

LOCALDIR = os.path.abspath(os.path.dirname(__file__))
HTML5DIR = os.path.join(LOCALDIR, os.pardir, 'html5')

# the files of the client: {url: (file name, content type)}
CLIENT_FILES = {
    'html5/bubbros.js': ('bubbros.js', 'text/javascript; charset=utf-8'),
    'html5/inflate.js': ('inflate.js', 'text/javascript; charset=utf-8'),
    'html5/bubbros.css': ('bubbros.css', 'text/css; charset=utf-8'),
    }

# The WebRTC data channel uses one UDP port per client.  With
# '--port WEBRTC=#' they are taken from the range that starts at #.
WEBRTC_PORT_COUNT = 32      # as gamesrv.MAX_CLIENTS

# Frames are dropped when that many bytes are still waiting to be sent
# on the data channel.
UDP_BACKLOG = 65536
TEXT_LIMIT = 65536          # longest WebRTC signaling message

EMPTY_PAGE = '''<html>
<head><title>No server is running</title></head>
<body><h1>No server is running at the moment.</h1>
</body>
</html>
'''


def ice_servers():
    """STUN or TURN servers, for a server or clients behind a NAT:
    BUBBROS_ICE_SERVERS=stun:stun.example.org:3478,..."""
    value = os.environ.get('BUBBROS_ICE_SERVERS', '')
    return [url.strip() for url in value.split(',') if url.strip()]


# ____________________________________________________________
# The transport of one browser

class BrowserTransport(Transport):
    """WebSocket + WebRTC data channel.

    The methods of Transport are called by the game, in the main
    thread.  The methods whose name starts with an underscore run in the
    asyncio thread."""

    kind = 'websocket'

    def __init__(self, hub, ws, addr):
        self.hub = hub
        self.loop = hub.loop
        self.ws = ws
        self.addr = addr
        self.lock = threading.Lock()
        # incoming stream: a queue, and a socket pair for select()
        self.rsock, self.wsock = socket.socketpair()
        self.rsock.setblocking(0)
        self.wsock.setblocking(0)
        self.inq = []
        self.signaled = False
        self.eof = False        # closed by the browser
        self.closed = False     # closed by the game
        self.writable = True
        self.textparts = None   # a text message being received
        self.textsize = 0
        # WebRTC
        self.pc = None
        self.dc = None
        self.tasks = set()

    # ---- the reliable stream ----

    def send_tcp(self, data):
        if self.closed or self.eof:
            raise error("connection closed")
        if not self.writable:
            raise BlockingIOError(EWOULDBLOCK, "the WebSocket is busy")
        self.loop.call_soon_threadsafe(self._ws_send, bytes(data))
        return len(data)

    def sendall_tcp(self, data):
        if self.closed or self.eof:
            raise error("connection closed")
        self.loop.call_soon_threadsafe(self._ws_send, bytes(data))

    def recv_tcp(self, bufsize):
        with self.lock:
            if self.signaled:
                self.signaled = False
                try:
                    self.rsock.recv(16)
                except error:
                    pass
            data = b''.join(self.inq)
            del self.inq[:]
            if data and self.eof:
                # the end must still wake up the game, after this data
                self._wakeup()
        return data

    def at_eof(self):
        return self.eof or self.closed

    # ---- the datagrams ----

    def open_udp(self, host=None, port=None):
        # the data channel is opened by the browser before it asks
        if self.dc is None:
            raise error("the WebRTC data channel is not open")
        self.udp_kind = 'webrtc'

    def send_udp(self, data):
        if self.dc is None:
            return 0
        self.loop.call_soon_threadsafe(self._dc_send, data)
        return len(data)

    def close_udp(self):
        self.udp_kind = None

    # ---- the rest ----

    def fileno(self):
        return self.rsock.fileno()

    def getsockname(self):
        return ('', self.hub.port)

    def getpeername(self):
        return self.addr

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.rsock.close()
            self.wsock.close()
        try:
            self.loop.call_soon_threadsafe(self._shutdown)
        except RuntimeError:
            pass    # the loop is gone

    # ---- in the asyncio thread: WebSocket ----

    def _wakeup(self):
        # with self.lock
        if not self.signaled and not self.closed:
            self.signaled = True
            try:
                self.wsock.send(b'x')
            except error:
                pass

    def _feed(self, data):
        with self.lock:
            self.inq.append(data)
            self._wakeup()

    def _lost(self):
        with self.lock:
            self.eof = True
            self._wakeup()
        self._rtc_close()

    def _ws_send(self, data):
        try:
            self.ws.send(picows.WSMsgType.BINARY, data)
        except Exception:
            pass    # disconnected: the game will see it in recv_tcp()

    def _ws_text(self, obj):
        try:
            self.ws.send(picows.WSMsgType.TEXT, json.dumps(obj).encode())
        except Exception:
            pass

    def _shutdown(self):
        self._rtc_close()
        try:
            self.ws.send_close(picows.WSCloseCode.OK)
            self.ws.disconnect()
        except Exception:
            pass

    # ---- in the asyncio thread: WebRTC signaling ----

    def _signaling(self, text):
        try:
            msg = json.loads(text)
            kind = msg['type']
            if kind == 'offer':
                self._rtc_close()
                lo = PORTS.get('WEBRTC') or 0
                config = aiolibdatachannel.RTCConfiguration(
                    ice_servers=ice_servers(),
                    port_range_begin=lo,
                    port_range_end=lo and lo + WEBRTC_PORT_COUNT - 1)
                self.pc = aiolibdatachannel.PeerConnection(config)
                self._spawn(self._rtc_answer(self.pc, str(msg['sdp'])))
            elif kind == 'candidate' and self.pc is not None:
                self._spawn(self.pc.add_remote_candidate(
                    str(msg['candidate']), str(msg.get('mid') or '')))
        except Exception as e:
            print('html5: bad WebRTC signaling from %s: %s' % (
                self.addr[0], e), file=sys.stderr)

    def _spawn(self, coro):
        task = self.loop.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self._task_done)

    def _task_done(self, task):
        self.tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            # no data channel: the client falls back to the WebSocket
            print('html5: WebRTC with %s: %s' % (
                self.addr[0], task.exception()), file=sys.stderr)

    async def _rtc_answer(self, pc, sdp):
        await pc.set_remote_description(sdp, 'offer')
        answer = await pc.create_answer()   # with all our candidates
        self._ws_text({'type': 'answer', 'sdp': answer.sdp})
        dc = await asyncio.wait_for(pc.accept_data_channel(), 30)
        await asyncio.wait_for(dc.wait_open(), 30)
        if pc is self.pc:
            self.dc = dc
            # now the browser can ask for the frames with CMSG_UDP_PORT
            self._ws_text({'type': 'ready'})

    def _rtc_close(self):
        self.dc = None
        pc, self.pc = self.pc, None
        for task in list(self.tasks):
            task.cancel()
        if pc is not None:
            try:
                pc.close()
            except Exception:
                pass

    def _dc_send(self, data):
        dc = self.dc
        if dc is None:
            return
        try:
            if (dc.buffered_amount > UDP_BACKLOG or
                len(data) > dc.max_message_size):
                return      # dropped, as UDP would
            # does not wait: the coroutine finishes at once
            task = self.loop.create_task(dc.send(data, wait_for_drain=False))
            task.add_done_callback(_ignore_result)
        except Exception:
            self.dc = None

def _ignore_result(task):
    if not task.cancelled():
        task.exception()


class _Listener(picows.WSListener):
    # the picows side of a BrowserTransport

    def __init__(self, hub):
        self.hub = hub
        self.transport = None

    def on_ws_connected(self, ws):
        addr = ws.underlying_transport.get_extra_info('peername')
        addr = tuple(addr[:2]) if addr else ('?', 0)
        self.transport = BrowserTransport(self.hub, ws, addr)
        self.hub._incoming(self.transport)

    def on_ws_frame(self, ws, frame):
        t = self.transport
        tp = frame.msg_type
        if tp == picows.WSMsgType.BINARY:
            t._feed(frame.get_payload_as_bytes())
        elif tp == picows.WSMsgType.TEXT:
            t.textparts = []
            t.textsize = 0
            self.textpart(t, frame)
        elif tp == picows.WSMsgType.CONTINUATION:
            if t.textparts is not None:
                self.textpart(t, frame)
            else:
                t._feed(frame.get_payload_as_bytes())
        elif tp == picows.WSMsgType.CLOSE:
            ws.send_close(frame.get_close_code(), frame.get_close_message())
            ws.disconnect()

    def textpart(self, t, frame):
        # a longer message is dropped, without keeping its parts
        payload = frame.get_payload_as_bytes()
        t.textsize += len(payload)
        if t.textsize <= TEXT_LIMIT:
            t.textparts.append(payload)
        if frame.fin:
            data = b''.join(t.textparts)
            ok = t.textsize <= TEXT_LIMIT
            t.textparts = None
            if ok:
                t._signaling(data.decode('utf-8', 'replace'))

    def on_ws_disconnected(self, ws):
        if self.transport is not None:
            self.transport._lost()

    def pause_writing(self):
        self.transport.writable = False

    def resume_writing(self):
        self.transport.writable = True


# ____________________________________________________________
# The listening side

class Hub:
    """Listens for the browsers, in an asyncio loop in its own thread.

    For the game it looks like a listening socket: select() says that
    it is readable when browsers have connected, and accept() returns
    their transports."""

    def __init__(self, port=None):
        self.loop = asyncio.new_event_loop()
        self.rsock, self.wsock = socket.socketpair()
        self.rsock.setblocking(0)
        self.wsock.setblocking(0)
        self.lock = threading.Lock()
        self.pending = deque()
        self.port = None
        self.startup_error = None
        started = threading.Event()
        self.thread = threading.Thread(target=self._run,
                                       args=(port or 0, started),
                                       name='html5', daemon=True)
        self.thread.start()
        started.wait()
        if self.startup_error is not None:
            raise error("cannot listen for WebSockets: %s" % (
                self.startup_error,))

    def fileno(self):
        return self.rsock.fileno()

    def getsockname(self):
        return ('', self.port)

    def accept(self):
        "The transports of the browsers that connected since last time."
        with self.lock:
            try:
                self.rsock.recv(64)
            except error:
                pass
            result = list(self.pending)
            self.pending.clear()
        return result

    # ---- in the asyncio thread ----

    def _run(self, port, started):
        asyncio.set_event_loop(self.loop)
        try:
            server = self.loop.run_until_complete(picows.ws_create_server(
                self._listener_factory, '0.0.0.0', port))
            self.port = server.sockets[0].getsockname()[1]
        except Exception as e:
            self.startup_error = e
            return
        finally:
            started.set()
        self.loop.run_forever()

    def _incoming(self, transport):
        with self.lock:
            self.pending.append(transport)
            try:
                self.wsock.send(b'x')
            except error:
                pass

    def _listener_factory(self, request):
        if 'websocket' in request.headers.get('upgrade', '').lower():
            return _Listener(self)
        # not a WebSocket: the pages are on the HTTP server of the game
        return None     # 404


# ____________________________________________________________
# The pages

def indexpage():
    "The page with the HTML5 client, as bytes."
    import gamesrv
    game = gamesrv.game
    ws = gamesrv.findsocket('WEBSOCKET')
    if game is None or ws is None:
        return EMPTY_PAGE.encode('utf-8')
    config = {
        'title':      game.FnDesc,
        'width':      game.width,
        'height':     game.height,
        'wsport':     gamesrv.displaysockport(ws),
        'iceServers': ice_servers(),
        }
    with open(os.path.join(HTML5DIR, 'index.html'), 'rb') as f:
        page = f.read().decode('utf-8')
    config = json.dumps(config).replace('</', '<\\/')
    return page.replace('/*CONFIG*/{}', config).encode('utf-8')

def indexloader(**options):
    # for httpserver.py
    import javaserver
    javaserver.docheats(options)
    return BytesIO(indexpage()), 'text/html; charset=utf-8'

def setup():
    "Register the HTML5 client as the default page of the HTTP server."
    import httpserver, javaserver
    # public: served to the other computers too
    httpserver.register('', indexloader, public=True)
    httpserver.register('index.html', indexloader, public=True)
    javaserver.register_name_page('', javaserver.makenameloader(indexloader))
    for path, (filename, ctype) in CLIENT_FILES.items():
        httpserver.register(path, httpserver.fileloader(
            os.path.join(HTML5DIR, filename), ctype), public=True)
