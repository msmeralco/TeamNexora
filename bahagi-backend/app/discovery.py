"""Lets the ESP32 find this laptop by itself: every 2 s, shout "BAHAGI:8000" to every Wi-Fi this laptop is on
(UDP broadcast, port 4210). The box takes the sender's address. No internet needed, no IP to type."""
import socket
import threading
import time

PORT_ESP = 4210


def _local_ips():
    ips = {"0.0.0.0"}
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    return ips


def _loop(http_port: int, stop: threading.Event):
    msg = f"BAHAGI:{http_port}".encode()
    while not stop.is_set():
        for ip in _local_ips():                     # one shout per network card (Wi-Fi, Windows hotspot, ...)
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.bind((ip, 0))
                s.sendto(msg, ("255.255.255.255", PORT_ESP))
                if ip != "0.0.0.0":                 # also the subnet's own broadcast address (x.y.z.255)
                    s.sendto(msg, (ip.rsplit(".", 1)[0] + ".255", PORT_ESP))
                s.close()
            except Exception:
                pass
        stop.wait(2)


def start(http_port: int = 8000):
    stop = threading.Event()
    threading.Thread(target=_loop, args=(http_port, stop), daemon=True, name="bahagi-beacon").start()
    return stop


def addresses():
    """Addresses this laptop can be reached at (for the startup message)."""
    return sorted(ip for ip in _local_ips() if ip != "0.0.0.0")
