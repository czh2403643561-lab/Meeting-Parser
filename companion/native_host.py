"""Persistent Chrome/Edge Native Messaging host for direct MP4 downloads."""

from __future__ import annotations

import json
import queue
import struct
import sys
import threading
import time
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from local_downloader import DownloadError, cancel_download, create_download, task_snapshot

COMPANION_VERSION = "0.6.0"
MAX_MESSAGE_BYTES = 1024 * 1024
POLL_SECONDS = 0.1
DISCONNECT_CANCEL_TIMEOUT = 2.0


def read_message() -> dict | None:
    try:
        header = sys.stdin.buffer.read(4)
    except OSError:
        return None
    if len(header) != 4:
        return None
    length = struct.unpack("<I", header)[0]
    if length > MAX_MESSAGE_BYTES:
        return {}
    try:
        payload = sys.stdin.buffer.read(length)
    except OSError:
        return None
    if len(payload) != length:
        return None
    try:
        value = json.loads(payload.decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def send_message(payload: dict, lock: threading.Lock) -> bool:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    try:
        with lock:
            sys.stdout.buffer.write(struct.pack("<I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        return True
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
        return False


def reader(messages: queue.Queue[dict | None]) -> None:
    while True:
        message = read_message()
        if message is None:
            messages.put(None)
            return
        messages.put(message)


def status_payload(request_id: str, task: dict) -> dict:
    return {
        "type": "downloadStatus",
        "requestId": request_id,
        "status": task.get("status", "failed"),
        "filename": task.get("filename", ""),
        "bytes": int(task.get("bytes") or 0),
        "totalBytes": task.get("totalBytes"),
        "progress": task.get("progress"),
        "error": task.get("error", ""),
    }


def failed_payload(request_id: str, error: str) -> dict:
    return {
        "type": "downloadStatus",
        "requestId": request_id,
        "status": "failed",
        "filename": "",
        "bytes": 0,
        "totalBytes": None,
        "progress": None,
        "error": error,
    }


def main() -> None:
    messages: queue.Queue[dict | None] = queue.Queue()
    threading.Thread(target=reader, args=(messages,), daemon=True).start()
    output_lock = threading.Lock()
    active: dict | None = None
    last_signature: tuple | None = None

    while True:
        try:
            message = messages.get(timeout=POLL_SECONDS)
        except queue.Empty:
            message = ...

        if message is None:
            if active and active.get("taskId"):
                cancel_download(active["taskId"])
                deadline = time.monotonic() + DISCONNECT_CANCEL_TIMEOUT
                while time.monotonic() < deadline:
                    task = task_snapshot(active["taskId"])
                    if not task or task.get("status") in {"complete", "failed"}:
                        break
                    time.sleep(POLL_SECONDS)
            return

        if message is not ...:
            message_type = message.get("type")
            if message_type == "hello":
                if not send_message({"type": "hello", "version": COMPANION_VERSION}, output_lock):
                    return
            elif message_type == "startDownload":
                request_id = str(message.get("requestId", "")).strip()
                if not request_id:
                    continue
                if active:
                    current = task_snapshot(active["taskId"])
                    if current and current.get("status") not in {"complete", "failed"}:
                        if not send_message(failed_payload(request_id, "已有下载任务正在进行，请稍后再试。"), output_lock):
                            return
                        continue
                    active = None
                    last_signature = None
                try:
                    task_id, filename = create_download(
                        {
                            "url": message.get("url"),
                            "filename": message.get("filename", "video.mp4"),
                            "headers": message.get("headers", {}),
                        }
                    )
                except DownloadError as error:
                    if not send_message(failed_payload(request_id, str(error)), output_lock):
                        return
                    continue
                except (KeyError, TypeError, ValueError):
                    if not send_message(failed_payload(request_id, "下载参数无效。"), output_lock):
                        return
                    continue
                active = {"requestId": request_id, "taskId": task_id, "filename": filename}
                last_signature = None

        if active:
            task = task_snapshot(active["taskId"])
            if task is None:
                if not send_message(failed_payload(active["requestId"], "下载任务状态丢失。"), output_lock):
                    return
                active = None
                last_signature = None
            else:
                payload = status_payload(active["requestId"], task)
                signature = tuple(payload.items())
                if signature != last_signature:
                    if not send_message(payload, output_lock):
                        return
                    last_signature = signature
                if task.get("status") in {"complete", "failed"}:
                    active = None
                    last_signature = None


if __name__ == "__main__":
    main()
