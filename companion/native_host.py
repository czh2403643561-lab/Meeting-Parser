"""Chrome/Edge Native Messaging host for starting the local downloader silently."""

from __future__ import annotations

import http.client
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("MEETING_PARSER_PORT", "8765"))
START_TIMEOUT_SECONDS = 7
MAX_MESSAGE_BYTES = 1024 * 1024
DOWNLOADER_NAME = "MeetingParserDownloader.exe"


def application_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def downloader_path() -> Path:
    return application_directory() / DOWNLOADER_NAME


def service_is_ready(timeout: float = 0.5) -> bool:
    connection = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
    try:
        connection.request("GET", "/health", headers={"Connection": "close"})
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        return response.status == 200 and body.get("ok") is True
    except (OSError, ValueError, json.JSONDecodeError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def start_downloader() -> tuple[bool, str]:
    if service_is_ready():
        return True, "ready"

    executable = downloader_path()
    if not executable.is_file():
        return False, "downloader_missing"

    startup_info = subprocess.STARTUPINFO()
    startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup_info.wShowWindow = subprocess.SW_HIDE
    creation_flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    try:
        subprocess.Popen(
            [str(executable)],
            cwd=str(executable.parent),
            close_fds=True,
            creationflags=creation_flags,
            startupinfo=startup_info,
        )
    except OSError:
        return False, "downloader_start_failed"

    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if service_is_ready():
            return True, "started"
        time.sleep(0.2)
    return False, "downloader_not_ready"


def read_message() -> dict | None:
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return None
    length = struct.unpack("<I", header)[0]
    if length > MAX_MESSAGE_BYTES:
        return {}
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        return None
    try:
        value = json.loads(payload.decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def send_message(payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def handle_message(message: dict) -> dict:
    if message.get("action") != "ensureDownloader":
        return {"ok": False, "code": "unsupported_action"}
    ready, code = start_downloader()
    return {"ok": ready, "code": code}


def main() -> None:
    # Native Messaging uses stdin/stdout only. Never write diagnostics to stdout.
    message = read_message()
    if message is not None:
        send_message(handle_message(message))


if __name__ == "__main__":
    main()
