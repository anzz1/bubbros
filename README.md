# bubbros
Adopt from sf.net Bub n Bros for port to Python3

Original: http://bub-n-bros.sourceforge.net

The game now runs on Python 3. The server, the clients and the
metaserver use the same network protocol as version 1.6.2, so old
Python 2 clients and servers can still play with the new ones.

## What you need

- Python 3.5+ (3.8+ for the tests).
- On Linux and other systems: pygame, for the usual client display and
  sound.  
  On Debian or Ubuntu:

      sudo apt install python3 python3-pygame

  For non-managed Python installations, via pip:

      python3 -m pip install pygame

- On Windows: pygame, as above (via pip). Altenatively, you can use a
  native Windows display and sound driver in form of a C extension,
  built once with

      cd display && python setup.py build_ext -i

  To build the extension you need Microsoft Visual C++ 14.x: Visual
  Studio 2015 or later, or the free Build Tools for Visual Studio, with
  the "Desktop development with C++" workload. setuptools finds the
  compiler by itself, no developer command prompt needed. With Python
  3.12 or later, first `pip install setuptools` (distutils is gone).

Optional:

- GTK 3 client display: `python3-gi gir1.2-gtk-3.0 python3-gi-cairo`
- X11 client display (`-d X`), a C extension: `python3-dev python3-setuptools
  libx11-dev libxext-dev`, then `make -C display`.
- HTML5 client, to play in a web browser (`html5` driver): Python 3.12 or
  later and the packages `picows` and `aiolibdatachannel` (picows requires >=
  3.9, aiolibdatachannel >= 3.12). `make html5`, or
  `pip install ./html5`, installs them. See "Playing in a web browser".
- OSS sound (`-s linux`) or Windows sound: the `audioop` module. Python 3.13
  removed it from the standard library; install `python3-audioop-lts`
  (Debian) or `pip install audioop-lts`.

## How to play

Start the game and open its page in your web browser:

    python3 BubBob.py

From the page you start a server, choose the levels and join the game.

Without the browser:

    python3 bubbob/bb.py bubbob/levels/Levels.bin     # the server
    python3 display/Client.py localhost:PORT          # a client

The server prints the PORT it listens on.

`python3 bubbob/bb.py --help` and `python3 display/Client.py --help` list
the options.

## Playing in a web browser

Every game server has a web page, on its HTTP port, with a client that
needs no installation: `http://HOST:HTTPPORT/` (the server prints the
address when it starts).

- With the `html5` driver installed on the server, that page is the HTML5
  client, and the old Java applet is at `/java/`.
- Without it, the page is the Java applet, as before. No current browser
  runs applets.

A browser cannot open TCP or UDP sockets, so the HTML5 client uses a
WebSocket instead of TCP and a WebRTC data channel instead of UDP. If the
data channel cannot be opened, everything goes over the WebSocket, like
the `--tcp` option of the Python client. The other clients are not
affected: they use plain sockets as before, and the game protocol is the
same for all of them (see `common/transport.py`).

Ports to open on the server for players on other computers: the HTTP
port (TCP), the WebSocket port (TCP) and the WebRTC ports (UDP). They are
chosen by the system unless you fix them, on the Options page or with

    python3 bubbob/bb.py --port HTTP=8000 --port WEBSOCKET=8001 \
        --port WEBRTC=8100 bubbob/levels/Levels.bin

`WEBRTC=8100` means the 32 UDP ports from 8100, one per client. For a
server behind a NAT, name STUN or TURN servers in
`BUBBROS_ICE_SERVERS=stun:stun.example.org:3478,...`.

Only the game's web client is served to other computers. The control
page of `BubBob.py` answers only to the computer it runs on.

## Internet games

Games on your local network show up by themselves, and you can always
join a game by its address. To find games on the Internet, the game uses
a meta-server, a list where servers register. The public one
(ctpug.org.za) no longer runs, so none is set by default.

To use one, give its address as `host`, `host:port` or
`host:port:httpport` (default ports 8055 and 8050), either on the Options
page, under Network options, or in an environment variable, which takes
precedence:

    BUBBROS_METASERVER=meta.example.org python3 BubBob.py

To run your own meta-server:

    python3 metaserver/metaserver.py [--port 8055] [--http 8050]

It needs these ports open: TCP and UDP 8055, TCP 8050. To run it as a
service, see `metaserver/bubbros-metaserver.service`.

## Tests

Python 3.8+:

    python3 -m unittest discover -s tests

Input and full screen on X11, GNOME, KDE, weston and sway, with real
input events (needs those compositors installed, see
tests/display/README.md):

    python3 tests/display/run.py

## License

The code is under the MIT license. The sounds, music and levels of the
original Mac game are by Sebastian Wegner (McSebi), under the Artistic
License 2.0. See LICENSE.txt.
