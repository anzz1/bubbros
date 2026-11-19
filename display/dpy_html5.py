"""The HTML5 "display driver": the game is displayed in a web browser.

Unlike the other drivers, this one is not a window of the Python client.
The client is a web page (html5/bubbros.js) that the game server serves
and talks to with WebSockets and WebRTC; see common/html5server.py.
What is here only says if the driver is installed, and opens the page.

The driver needs the packages picows and aiolibdatachannel (to install
them: 'make html5', or 'pip install ./html5').  Without them it is
listed as not installed and the rest of the game works as before.
"""

import sys

# raises ImportError if the driver is not installed
import picows, aiolibdatachannel


def page_url(sockaddr):
    """The URL of the page of the game server at 'sockaddr', or None if
    the server does not answer with the port of its HTTP server."""
    import socket, select
    from common import hostchooser
    host, port = sockaddr[:2]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for attempt in range(3):
            s.sendto(hostchooser.PING_MESSAGE.encode('ascii'),
                     (host, hostchooser.UDP_PORT))
            iwtd, owtd, ewtd = select.select([s], [], [], 0.5)
            if not iwtd:
                continue
            data, source = s.recvfrom(200)
            data = data.decode('utf-8', 'replace').split(':')
            # the HTTP port is last: the description may contain ':'
            if (len(data) >= 6 and data[0] == hostchooser.PONG_MESSAGE
                    and data[-1].isdigit()):
                return 'http://%s:%s/' % (host, data[-1])
    except socket.error:
        pass
    finally:
        s.close()
    return None

def run(sockaddr):
    "Open the page of the game server at 'sockaddr' in the web browser."
    url = page_url(sockaddr)
    if url is None:
        print("Cannot find the web page of the server at %s:%d." % (
            tuple(sockaddr[:2])), file=sys.stderr)
        print("Open http://%s:HTTPPORT/ in your web browser, with the "
              "port that the server printed when it started." % (
                  sockaddr[0],), file=sys.stderr)
        sys.exit(1)
    print("The game is at %s" % url)
    import webbrowser
    webbrowser.open(url)
