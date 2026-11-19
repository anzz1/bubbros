"""The JavaScript of the HTML5 client (html5/*.js) against the Python
code it has to agree with: zlib, the messages of common/msgstruct.py and
the compressed frames of gamesrv.py.  Needs node; skipped without it."""

import json
import os
import random
import shutil
import subprocess
import sys
import unittest
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
sys.path[:0] = [ROOT, os.path.join(ROOT, 'common')]

import gamesrv
from msgstruct import *

NODE = shutil.which('node')

# loads the two scripts as a page would, then runs the test code, which
# reads its input as JSON on stdin and writes its result as JSON
HARNESS = r'''
const fs = require('fs'), path = require('path');
global.window = global;
global.document = {readyState: 'loading', addEventListener() {}};
for (const name of ['inflate.js', 'bubbros.js'])
    (0, eval)(fs.readFileSync(path.join(process.argv[1], name), 'utf8'));
const hex = s => Uint8Array.from(Buffer.from(s, 'hex'));
const tohex = a => Buffer.from(a).toString('hex');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let output;
%s
process.stdout.write(JSON.stringify(output));
'''

def node(code, data):
    result = subprocess.run(
        [NODE, '-e', HARNESS % code, os.path.join(ROOT, 'html5')],
        input=json.dumps(data), capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)

def some_bytes(rnd, n):
    return bytes(rnd.choice(b'abcdefgh\x00\x01\xff') for i in range(n))


@unittest.skipIf(NODE is None, "node is not installed")
class JavaScript(unittest.TestCase):

    def test_music_file_complete(self):
        # blocks as gamesrv.Music sends them: the first one and the last
        # one (to the end of the file) together, then the others
        size, rate = 4 * 44100 + 100, 44100
        endpos = size - rate
        first = [(0, rate), (endpos, rate)]
        others = [(p, min(rate, endpos - p)) for p in range(rate, endpos, rate)]
        out = node('''
            const f = new bubbros.DataFile(7);     // (not connected)
            output = [f.complete()];
            for (const [p, n] of input.first)
                f.serverMd5(p, n);
            for (const [p, n] of input.first) {
                f.serverPatch(p, new Uint8Array(n));
                output.push(f.complete());
            }
            for (const [p, n] of input.others) {
                f.serverMd5(p, n);
                output.push(f.complete());      // asked for, not there
                f.serverPatch(p, new Uint8Array(n));
                output.push(f.complete());
            }
            output.push(f.read().length);''', {'first': first, 'others': others})
        *states, length = out
        self.assertEqual(states,
                         [False] * (1 + 2 + 2 * len(others) - 1) + [True])
        self.assertEqual(length, size)

    def test_inflate(self):
        rnd = random.Random(1)
        whole = os.urandom(3000) + some_bytes(rnd, 100000) + b'x' * 70000
        # one stream in pieces, each one ending with a sync flush
        co = zlib.compressobj(6)
        pieces = [some_bytes(rnd, rnd.choice([0, 5, 600, 40000]))
                  for i in range(20)]
        packets = [co.compress(p) + co.flush(zlib.Z_SYNC_FLUSH)
                   for p in pieces]
        out = node('''
            output = {
                whole: tohex(inflate(hex(input.whole))),
                pieces: (d => input.packets.map(p => tohex(d.feed(hex(p)))))(
                    new Inflater()),
                errors: input.bad.map(b => {
                    try { inflate(hex(b), 1000); return false; }
                    catch (e) { return true; } }),
            };''', {
            'whole': zlib.compress(whole).hex(),
            'packets': [p.hex() for p in packets],
            'bad': [zlib.compress(whole)[:500].hex(),       # truncated
                    b'not zlib data'.hex(),
                    zlib.compress(b'a' * 5000).hex()],      # over the limit
            })
        self.assertEqual(out['whole'], whole.hex())
        self.assertEqual(out['pieces'], [p.hex() for p in pieces])
        self.assertEqual(out['errors'], [True, True, True])

    def test_messages(self):
        msgs = [
            message(MSG_DEF_PLAYFIELD, 640, 480, 0, 'Bub & Bob'.encode()),
            message(MSG_DEF_ICON, 3, 70000, 0, 255, 256, -5),
            message(MSG_PING),
            message(MSG_INLINE_FRAME, bytes(range(256)) * 3),
            ]
        out = node('''
            const data = hex(input.stream);
            const decoded = [];
            for (let pos = 0;;) {
                const m = bubbros.decodeMessage(data, pos);
                if (!m) break;
                pos = m.end;
                decoded.push(m.values.map(
                    v => v instanceof Uint8Array ? {hex: tohex(v)} : v));
            }
            output = {
                decoded: decoded,
                cut: bubbros.decodeMessage(data.subarray(0, 12), 0),
                encoded: [
                    bubbros.message('v', 3),
                    bubbros.message('k', 2, 300),
                    bubbros.message('<', hex('5c')),
                    bubbros.message('M', 7, 1000000, -1),
                    bubbros.message('n', 0, hex(input.name)),
                ].map(tohex),
            };''', {'stream': b''.join(msgs).hex(),
                    'name': 'Bübb'.encode().hex()})
        expected = []
        for msg in msgs:
            values, rest = decodemessage(msg)
            expected.append([v.decode('latin-1') if i == 0 else
                             {'hex': v.hex()} if isinstance(v, bytes) else v
                             for i, v in enumerate(values)])
        self.assertEqual(out['decoded'], expected)
        self.assertIsNone(out['cut'])
        self.assertEqual(out['encoded'], [m.hex() for m in [
            message(CMSG_PROTO_VERSION, 3),
            message(CMSG_KEY, 2, 300),
            message(CMSG_UDP_PORT, MSG_INLINE_FRAME),
            message(CMSG_DATA_REQUEST, 7, 1000000, -1),
            message(CMSG_PLAYER_NAME, 0, 'Bübb'.encode()),
            ]])

    def test_wav_header(self):
        # the music is played from the blocks of its .wav file
        import io, wave
        def wav(channels, width, rate, frames):
            f = io.BytesIO()
            w = wave.open(f, 'wb')
            w.setnchannels(channels)
            w.setsampwidth(width)
            w.setframerate(rate)
            w.writeframes(b'\x80' * (frames * channels * width))
            w.close()
            return f.getvalue()
        with open(os.path.join(ROOT, 'bubbob', 'music', 'Snd1-8.wav'),
                  'rb') as f:
            game = f.read(44100)        # the first block
        out = node('output = input.map(h => bubbros.parseWav(hex(h)));', [
            game.hex(),
            wav(2, 2, 22050, 100).hex(),
            wav(1, 1, 8000, 100)[:30].hex(),    # no data yet
            wav(1, 3, 8000, 100).hex(),         # 24 bits
            b'OggS not a wav file at all'.hex(),
            ])
        self.assertEqual(out[0], {
            'channels': 1, 'rate': 44100, 'bits': 8, 'align': 1, 'start': 44,
            'end': os.path.getsize(os.path.join(ROOT, 'bubbob', 'music',
                                                'Snd1-8.wav'))})
        self.assertEqual(out[1], {'channels': 2, 'rate': 22050, 'bits': 16,
                                  'align': 4, 'start': 44, 'end': 444})
        self.assertEqual(out[2:], [None, None, None])

    def frames_and_packets(self, count):
        # what gamesrv.Client sends over the datagram channel
        class Sender:
            setup_dyncompress = gamesrv.Client.setup_dyncompress
            dynamic_compress = gamesrv.Client.dynamic_compress
        sender = Sender()
        sender.setup_dyncompress()
        rnd = random.Random(2)
        frame = some_bytes(rnd, 600)
        frames, packets = [], []
        for i in range(count):
            # a frame looks like the previous one
            frame = bytearray(frame)
            for j in range(rnd.randrange(0, 12)):
                frame[rnd.randrange(len(frame))] = rnd.randrange(256)
            frame = bytes(frame)
            frames.append(frame)
            packets.append(sender.dynamic_compress(frame))
        return frames, packets

    DECODE = '''
        output = input.map(packets => {
            let result = null;
            for (const p of packets) {
                const data = bubbros.dynamicDecompress(hex(p));
                if (data) result = tohex(data);
            }
            return result;
        });'''

    def test_frames_without_loss(self):
        frames, packets = self.frames_and_packets(300)
        out = node(self.DECODE, [[p.hex() for p in ps] for ps in packets])
        self.assertEqual(out, [f.hex() for f in frames])

    def test_frames_with_lost_packets(self):
        frames, packets = self.frames_and_packets(600)
        rnd = random.Random(3)
        received = [[p.hex() for p in ps if rnd.random() > 0.2]
                    for ps in packets]
        out = node(self.DECODE, received)
        # the Python client, with the same packets
        sys.path.insert(0, os.path.join(ROOT, 'display'))
        self.addCleanup(sys.path.remove, os.path.join(ROOT, 'display'))
        import pclient
        pf = pclient.Playfield.__new__(pclient.Playfield)
        pf.dyndecompress = [[None, None, None, None] for i in range(8)]
        pf.dynnorepeat = None
        expected = []
        for ps in received:
            result = None
            for p in ps:
                data = pf.dynamic_decompress(bytes.fromhex(p))
                if data is not None:
                    result = data.hex()
            expected.append(result)
        self.assertEqual(out, expected)
        # a frame is either lost or exactly right, and many are not lost
        decoded = 0
        for got, frame in zip(out, frames):
            if got is not None:
                self.assertEqual(got, frame.hex())
                decoded += 1
        self.assertGreater(decoded, len(frames) // 4)


if __name__ == '__main__':
    unittest.main()
