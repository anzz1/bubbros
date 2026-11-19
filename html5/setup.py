#! /usr/bin/env python3

# The "html5" driver: the game in a web browser.
#
# The client is the web page in this directory (index.html, bubbros.js,
# inflate.js).  The game server talks to it with WebSockets and WebRTC
# (see common/html5server.py), which need two packages that the rest of
# the game does not.  Installing this installs them:
#
#     pip install ./html5          (or 'make html5' in the main directory)
#
# Nothing else is installed: the driver itself runs from the source
# directory like the rest of the game.  Without these packages the game
# works as before, and only this driver is missing.

from setuptools import setup

setup ( name="bubbros-html5",
        version="0.1",
        description="HTML5 client driver for the Bub & Bob game server "
                    "(WebSockets and WebRTC)",
        author="The Bub's Brothers contributors",
        url="https://github.com/alexmyczko/bubbros",
        license="MIT",
        py_modules=[],
        # what the two packages themselves support
        python_requires=">=3.12",
        install_requires=[
            "picows>=2.3.2",                   # WebSockets, for the TCP side
            "aiolibdatachannel>=2026.11.10",   # WebRTC data channels, for UDP
            ],
        )
