"""The server side of the HTML5 client (common/html5server.py), with a
WebSocket and a WebRTC peer that do what the browser does.  Skipped if
the html5 driver is not installed."""

import asyncio
import json
import os
import select
import socket
import sys
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
sys.path[:0] = [ROOT, os.path.join(ROOT, 'common')]

try:
    import html5server
    import picows
    import aiolibdatachannel
except ImportError:
    html5server = None

from transport import Transport


class Browser(picows.WSListener if html5server else object):
    "What the page does with its WebSocket."

    def __init__(self):
        self.stream = asyncio.Queue()
        self.signaling = asyncio.Queue()
        self.disconnected = asyncio.Event()

    def on_ws_frame(self, ws, frame):
        if frame.msg_type == picows.WSMsgType.BINARY:
            self.stream.put_nowait(frame.get_payload_as_bytes())
        elif frame.msg_type == picows.WSMsgType.TEXT:
            self.signaling.put_nowait(
                json.loads(frame.get_payload_as_utf8_text()))

    def on_ws_disconnected(self, ws):
        self.disconnected.set()


@unittest.skipIf(html5server is None, "the html5 driver is not installed")
class Html5(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.hub = html5server.Hub()

    def run_async(self, coro):
        return asyncio.run(asyncio.wait_for(coro, 30))

    async def connect(self):
        ws, browser = await picows.ws_connect(
            Browser, 'ws://127.0.0.1:%d/' % self.hub.port)
        return ws, browser

    def accept(self):
        "The game side: wait for the hub to be readable, then accept()."
        iwtd, owtd, ewtd = select.select([self.hub], [], [], 10)
        self.assertEqual(iwtd, [self.hub])
        transports = self.hub.accept()
        self.assertEqual(len(transports), 1)
        self.addCleanup(transports[0].close)
        return transports[0]

    async def in_thread(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(
            None, fn, *args)

    def recv(self, t, count):
        "The game side: read 'count' bytes from the stream."
        data = b''
        while len(data) < count:
            iwtd, owtd, ewtd = select.select([t], [], [], 10)
            self.assertEqual(iwtd, [t])
            data += t.recv_tcp(2048)
        return data

    def test_stream(self):
        async def scenario():
            ws, browser = await self.connect()
            t = await self.in_thread(self.accept)
            self.assertIsInstance(t, Transport)
            self.assertEqual(t.kind, 'websocket')
            self.assertEqual(t.getpeername()[0], '127.0.0.1')
            # server -> browser
            self.assertEqual(t.send_tcp(b'Welcome'), 7)
            t.sendall_tcp(b' to the game')
            data = b''
            while len(data) < 19:
                data += await browser.stream.get()
            self.assertEqual(data, b'Welcome to the game')
            # browser -> server, in any number of frames
            ws.send(picows.WSMsgType.BINARY, b'abc')
            ws.send(picows.WSMsgType.BINARY, b'def')
            self.assertEqual(await self.in_thread(self.recv, t, 6), b'abcdef')
            # nothing more: not readable, and no end of file
            self.assertEqual(select.select([t], [], [], 0.05)[0], [])
            self.assertEqual(t.recv_tcp(2048), b'')
            self.assertFalse(t.at_eof())
            ws.disconnect()
        self.run_async(scenario())

    def test_browser_goes_away(self):
        async def scenario():
            ws, browser = await self.connect()
            t = await self.in_thread(self.accept)
            ws.disconnect()
            def wait_eof():
                select.select([t], [], [], 10)
                return t.recv_tcp(2048), t.at_eof()
            self.assertEqual(await self.in_thread(wait_eof), (b'', True))
            self.assertRaises(socket.error, t.send_tcp, b'x')
        self.run_async(scenario())

    def test_server_closes(self):
        async def scenario():
            ws, browser = await self.connect()
            t = await self.in_thread(self.accept)
            t.send_tcp(b'bye')
            t.close()
            self.assertEqual(await browser.stream.get(), b'bye')
            await browser.disconnected.wait()
            self.assertTrue(t.at_eof())
            t.close()       # twice is fine
        self.run_async(scenario())

    def test_datagrams_over_webrtc(self):
        async def scenario():
            ws, browser = await self.connect()
            t = await self.in_thread(self.accept)
            # no data channel yet: the game cannot send frames there
            self.assertRaises(socket.error, t.open_udp)
            self.assertEqual(t.send_udp(b'lost'), 0)
            # what html5/bubbros.js does: an unordered data channel
            # without retransmissions, the offer over the WebSocket
            pc = aiolibdatachannel.PeerConnection()
            try:
                dc = await pc.create_data_channel(
                    'frames', aiolibdatachannel.DataChannelOptions(
                        ordered=False, max_retransmits=0))
                offer = await pc.create_offer()
                ws.send(picows.WSMsgType.TEXT, json.dumps(
                    {'type': 'offer', 'sdp': offer.sdp}).encode())
                answer = await browser.signaling.get()
                self.assertEqual(answer['type'], 'answer')
                await pc.set_remote_description(answer['sdp'], 'answer')
                await dc.wait_open()
                ready = await browser.signaling.get()
                self.assertEqual(ready, {'type': 'ready'})
                # now CMSG_UDP_PORT works
                t.open_udp('127.0.0.1', 1)
                self.assertEqual(t.udp_kind, 'webrtc')
                self.assertEqual(t.send_udp(b'\x00\x01 frame'), 8)
                self.assertEqual(await dc.recv(), b'\x00\x01 frame')
                # the stream still works next to it
                t.send_tcp(b'msg')
                self.assertEqual(await browser.stream.get(), b'msg')
            finally:
                await pc.aclose()
            ws.disconnect()
        self.run_async(scenario())

    def test_bad_signaling_is_ignored(self):
        async def scenario():
            ws, browser = await self.connect()
            t = await self.in_thread(self.accept)
            for text in (b'not json', b'{"type": "offer"}', b'[1]',
                         b'{"type": "candidate", "candidate": "x"}',
                         b'{"type": "offer", "sdp": "garbage"}'):
                ws.send(picows.WSMsgType.TEXT, text)
            ws.send(picows.WSMsgType.BINARY, b'still there')
            self.assertEqual(await self.in_thread(self.recv, t, 11),
                             b'still there')
            ws.disconnect()
        import contextlib, io
        with contextlib.redirect_stderr(io.StringIO()):
            self.run_async(scenario())
            time.sleep(0.2)

    def handshake(self, connection):
        "The first line of the answer to a WebSocket handshake."
        s = socket.create_connection(('127.0.0.1', self.hub.port),
                                     timeout=10)
        self.addCleanup(s.close)
        s.sendall(('GET / HTTP/1.1\r\n'
                   'Host: 127.0.0.1:%d\r\n'
                   'Sec-WebSocket-Version: 13\r\n'
                   'Sec-WebSocket-Extensions: permessage-deflate\r\n'
                   'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
                   'Connection: %s\r\n'
                   'Upgrade: websocket\r\n\r\n' % (
                       self.hub.port, connection)).encode('ascii'))
        return s.recv(4096).split(b'\r\n')[0]

    def test_handshake_of_each_browser(self):
        ok = b'HTTP/1.1 101 Switching Protocols'
        self.assertEqual(self.handshake('Upgrade'), ok)     # Chrome, Safari
        self.assertEqual(self.handshake('keep-alive, Upgrade'), ok)  # Firefox
        self.assertEqual(self.handshake('upgrade, keep-alive'), ok)
        # not an upgrade
        self.assertNotEqual(self.handshake('keep-alive'), ok)
        # three connections for the game, not four
        transports = []
        while select.select([self.hub], [], [], 0.5)[0]:
            transports += self.hub.accept()
        for t in transports:
            t.close()
        self.assertEqual(len(transports), 3)

    def test_port_is_only_for_websockets(self):
        # the pages are on the HTTP server of the game
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen('http://127.0.0.1:%d/' % self.hub.port,
                                   timeout=10)
        self.assertEqual(cm.exception.code, 404)

    def test_index_page(self):
        import gamesrv
        saved = gamesrv.game
        self.addCleanup(setattr, gamesrv, 'game', saved)
        gamesrv.game = None
        self.assertIn(b'No server is running', html5server.indexpage())
        class Game:
            FnDesc = 'A </script> game'
            width = 640
            height = 480
        gamesrv.game = Game()
        gamesrv.addsocket('WEBSOCKET', self.hub)
        self.addCleanup(gamesrv.removesocket, 'WEBSOCKET', self.hub)
        page = html5server.indexpage().decode('utf-8')
        self.assertIn('"wsport": %d' % self.hub.port, page)
        self.assertIn('"width": 640', page)
        self.assertNotIn('A </script> game', page)
        self.assertIn('html5/bubbros.js', page)


@unittest.skipIf(html5server is None, "the html5 driver is not installed")
class Html5Transport(unittest.TestCase):
    "BrowserTransport and the WebSocket frames, without a network."

    def transport(self):
        loop = type('Loop', (), {'call_soon_threadsafe':
                                 lambda self, *args: None})()
        hub = type('Hub', (), {'loop': loop, 'port': 0})()
        t = html5server.BrowserTransport(hub, None, ('1.2.3.4', 5))
        self.addCleanup(t.close)
        return t

    def readable(self, t):
        return bool(select.select([t], [], [], 0)[0])

    def test_end_after_data_wakes_up_the_game(self):
        t = self.transport()
        t._feed(b'data')
        t._lost()               # before the game read the data
        self.assertTrue(self.readable(t))
        self.assertEqual(t.recv_tcp(100), b'data')
        self.assertTrue(self.readable(t))
        self.assertEqual(t.recv_tcp(100), b'')
        self.assertTrue(t.at_eof())

    def test_long_text_messages_are_dropped(self):
        class Frame:
            def __init__(self, tp, fin, size):
                self.msg_type, self.fin, self.size = tp, fin, size
            def get_payload_as_bytes(self):
                return b'{' * self.size
        t = self.transport()
        got = []
        t._signaling = got.append
        listener = html5server._Listener(None)
        listener.transport = t
        frame = listener.on_ws_frame
        frame(None, Frame(picows.WSMsgType.TEXT, False, 40000))
        for i in range(10):
            frame(None, Frame(picows.WSMsgType.CONTINUATION, False, 40000))
            self.assertLessEqual(sum(map(len, t.textparts)),
                                 html5server.TEXT_LIMIT)
        frame(None, Frame(picows.WSMsgType.CONTINUATION, True, 1))
        self.assertEqual(got, [])
        # the next messages are not affected
        frame(None, Frame(picows.WSMsgType.TEXT, False, 3))
        frame(None, Frame(picows.WSMsgType.CONTINUATION, True, 2))
        self.assertEqual(got, ['{{{{{'])
        frame(None, Frame(picows.WSMsgType.CONTINUATION, True, 2))
        self.assertEqual(t.recv_tcp(100), b'{{')   # binary data

if __name__ == '__main__':
    unittest.main()
