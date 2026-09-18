"""Small loopback-only streaming downloader for direct MP4 resources."""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, parse_qs
from urllib.request import HTTPRedirectHandler, Request, build_opener

HOST = "127.0.0.1"
PORT = int(os.environ.get("MEETING_PARSER_PORT", "8765"))
COMPANION_VERSION = "0.5.0"
CHUNK_SIZE = 1024 * 1024
MAX_JSON_BYTES = 256 * 1024
MAX_HEADER_VALUE_LENGTH = 8192
LOG_BYTES_STEP = 50 * 1024 * 1024
LOG_PERCENT_STEP = 5
IDLE_EXIT_SECONDS = int(os.environ.get("MEETING_PARSER_IDLE_SECONDS", str(15 * 60)))
MAX_FILENAME_STEM_LENGTH = 220  # Keep this aligned with extension/title_utils.js.

ALLOWED_HEADERS = {
    "accept",
    "accept-language",
    "authorization",
    "cookie",
    "origin",
    "referer",
    "user-agent",
}
HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
HEADER_NAMES = {
    "accept": "Accept",
    "accept-language": "Accept-Language",
    "authorization": "Authorization",
    "cookie": "Cookie",
    "origin": "Origin",
    "referer": "Referer",
    "user-agent": "User-Agent",
}
BAD_CONTENT_TYPES = (
    "text/",
    "application/json",
    "application/javascript",
    "application/x-javascript",
    "application/xml",
    "text/xml",
)

TASKS: dict[str, dict] = {}
TASKS_LOCK = threading.RLock()
CANCEL_EVENTS: dict[str, threading.Event] = {}
ACTIVITY_LOCK = threading.Lock()
LAST_ACTIVITY = time.monotonic()
CLIENT_DISCONNECT_ERRNOS = {
    getattr(socket, "EPIPE", 32),
    getattr(socket, "ECONNRESET", 10054),
    getattr(socket, "ECONNABORTED", 10053),
    10053,  # Windows: software caused connection abort.
    10054,  # Windows: connection reset by peer.
}


class DownloadError(Exception):
    """An expected download failure that is safe to return to the extension."""


def log_message(message: str) -> None:
    stream = sys.stderr
    if stream is not None:
        print(message, file=stream, flush=True)


def note_activity() -> None:
    global LAST_ACTIVITY
    with ACTIVITY_LOCK:
        LAST_ACTIVITY = time.monotonic()


def seconds_since_activity() -> float:
    with ACTIVITY_LOCK:
        return time.monotonic() - LAST_ACTIVITY


def has_active_tasks() -> bool:
    with TASKS_LOCK:
        return any(task["status"] in {"queued", "connecting", "downloading"} for task in TASKS.values())


def is_client_disconnect(error: OSError) -> bool:
    return error.errno in CLIENT_DISCONNECT_ERRNOS


def downloads_directory() -> Path:
    return Path.home() / "Downloads"


def safe_filename(value: str) -> str:
    """Return a filename confined to the Downloads directory and ending in .mp4."""
    if not isinstance(value, str):
        value = "video.mp4"
    replacements = {
        "<": "＜",
        ">": "＞",
        ":": "：",
        '"': "＂",
        "/": "／",
        "\\": "＼",
        "|": "｜",
        "?": "？",
        "*": "＊",
    }
    value = "".join(replacements.get(character, character) for character in value)
    value = "".join(character for character in value if ord(character) >= 0x20 and ord(character) != 0x7F)
    value = re.sub(r"\s+", " ", value).strip().rstrip(" .")
    if value.casefold().endswith(".mp4"):
        value = value[:-4].rstrip()
    value = value[:MAX_FILENAME_STEM_LENGTH].rstrip(" .") or "video"
    return f"{value}.mp4"


def filter_request_headers(raw_headers: object) -> dict[str, str]:
    """Keep only browser headers useful for this GET; never return them to callers."""
    if not isinstance(raw_headers, dict):
        raise DownloadError("请求头格式无效。")

    filtered: dict[str, str] = {}
    for raw_name, raw_value in raw_headers.items():
        name = str(raw_name).strip().lower()
        if name not in ALLOWED_HEADERS or name in HOP_BY_HOP_HEADERS:
            continue
        if not isinstance(raw_value, str) or not raw_value:
            continue
        if len(raw_value) > MAX_HEADER_VALUE_LENGTH or "\r" in raw_value or "\n" in raw_value:
            raise DownloadError("请求头内容无效。")
        filtered[HEADER_NAMES[name]] = raw_value
    return filtered


def validate_url(value: object) -> str:
    if not isinstance(value, str):
        raise DownloadError("下载地址无效。")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise DownloadError("只允许下载 HTTP/HTTPS 地址。")
    return value


def is_bad_content_type(value: str) -> bool:
    content_type = (value or "").split(";", 1)[0].strip().lower()
    return content_type.startswith(BAD_CONTENT_TYPES)


def content_range_info(value: str) -> tuple[int, int, int | None] | None:
    match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", (value or "").strip(), re.IGNORECASE)
    if not match:
        return None
    total = None if match.group(3) == "*" else int(match.group(3))
    return int(match.group(1)), int(match.group(2)), total


def progress_for(downloaded: int, total: int | None) -> float | None:
    if total is None or total <= 0:
        return None
    return round(min(100.0, max(0.0, downloaded * 100 / total)), 1)


def format_bytes(value: int) -> str:
    return f"{value / (1024 * 1024):.1f} MB"


def log_progress(downloaded: int, total: int | None, last_bytes: int, last_progress: float) -> tuple[int, float]:
    progress = progress_for(downloaded, total)
    if progress is not None:
        if progress < last_progress + LOG_PERCENT_STEP and progress < 100:
            return last_bytes, last_progress
        log_message(f"[task] downloading: {format_bytes(downloaded)} / {format_bytes(total)} ({progress:.0f}%)")
        return downloaded, progress
    if downloaded - last_bytes >= LOG_BYTES_STEP:
        log_message(f"[task] downloading: {format_bytes(downloaded)}")
        return downloaded, last_progress
    return last_bytes, last_progress


def update_task(task_id: str, **changes: object) -> None:
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if task is not None:
            task.update(changes)


def task_snapshot(task_id: str) -> dict | None:
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        return dict(task) if task else None


def unique_target(filename: str) -> Path:
    directory = downloads_directory()
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / safe_filename(filename)
    if not candidate.exists() and not candidate.with_name(candidate.name + ".part").exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    for index in range(1, 10000):
        alternative = directory / f"{stem} ({index}){suffix}"
        if not alternative.exists() and not alternative.with_name(alternative.name + ".part").exists():
            return alternative
    raise DownloadError("无法生成不冲突的文件名。")


def same_origin(first: str, second: str) -> bool:
    left = urlsplit(first)
    right = urlsplit(second)
    return (left.scheme, left.hostname, left.port) == (right.scheme, right.hostname, right.port)


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, new_url):  # noqa: D401
        redirected = super().redirect_request(request, file, code, message, new_url)
        if redirected is not None and not same_origin(request.full_url, new_url):
            for collection in (redirected.headers, redirected.unredirected_hdrs):
                for name in ("Cookie", "Authorization", "Origin", "Referer"):
                    collection.pop(name, None)
        return redirected


def run_download(task_id: str, url: str, headers: dict[str, str], filename: str) -> None:
    target: Path | None = None
    part: Path | None = None
    total = 0
    total_bytes: int | None = None
    last_log_bytes = 0
    last_log_progress = 0
    try:
        note_activity()
        log_message(f"[task] started: {filename}")
        target = unique_target(filename)
        part = target.with_name(target.name + ".part")
        request = Request(url, headers=headers, method="GET")
        opener = build_opener(SafeRedirectHandler())
        update_task(task_id, status="connecting")

        try:
            response = opener.open(request, timeout=45)
        except HTTPError as error:
            raise DownloadError(f"远端服务器返回 HTTP {error.code}。") from error
        except URLError as error:
            raise DownloadError("无法连接媒体服务器。") from error

        with response:
            status = response.getcode()
            if status not in {HTTPStatus.OK, HTTPStatus.PARTIAL_CONTENT}:
                raise DownloadError(f"远端服务器返回 HTTP {status}。")

            content_type = response.headers.get("Content-Type", "")
            if is_bad_content_type(content_type):
                raise DownloadError("服务器返回了错误文本而不是 MP4，未保存文件。")
            content_length = response.headers.get("Content-Length", "")
            response_length = int(content_length) if content_length.isdigit() else None
            content_range = content_range_info(response.headers.get("Content-Range", ""))
            if status == HTTPStatus.PARTIAL_CONTENT and content_range:
                range_start, range_end, range_total = content_range
                total_bytes = range_total if range_total is not None else response_length
                expected_response_bytes = range_end - range_start + 1
                if range_start != 0 or (range_total is not None and range_end + 1 != range_total):
                    raise DownloadError("服务器只返回了部分媒体内容，未保存文件。")
            else:
                total_bytes = response_length
                expected_response_bytes = response_length

            update_task(
                task_id,
                status="downloading",
                totalBytes=total_bytes,
                progress=progress_for(0, total_bytes),
            )

            with part.open("wb") as output:
                while True:
                    chunk = response.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    output.write(chunk)
                    total += len(chunk)
                    if CANCEL_EVENTS.get(task_id) and CANCEL_EVENTS[task_id].is_set():
                        raise DownloadError("下载已取消。")
                    note_activity()
                    progress = progress_for(total, total_bytes)
                    update_task(task_id, bytes=total, totalBytes=total_bytes, progress=progress)
            last_log_bytes, last_log_progress = log_progress(
                total, total_bytes, last_log_bytes, last_log_progress
            )

            if expected_response_bytes is not None and total != expected_response_bytes:
                raise DownloadError("媒体响应不完整，未保存文件。")
            if total_bytes is not None and total != total_bytes:
                raise DownloadError("媒体响应不完整，未保存文件。")

        os.replace(part, target)
        update_task(
            task_id,
            status="complete",
            filename=target.name,
            bytes=total,
            totalBytes=total_bytes,
            progress=100.0,
            error="",
        )
        log_message(f"[task] completed: {target.name}")
    except Exception as error:  # The task must always remain observable by the side panel.
        if part is not None:
            try:
                part.unlink(missing_ok=True)
            except OSError:
                pass
        message = error.args[0] if isinstance(error, DownloadError) and error.args else "下载失败。"
        update_task(
            task_id,
            status="failed",
            error=str(message),
            filename=safe_filename(filename),
            bytes=total,
            totalBytes=total_bytes,
            progress=progress_for(total, total_bytes),
        )
        log_message(f"[task] failed: {message}")
    finally:
        CANCEL_EVENTS.pop(task_id, None)
        note_activity()


def create_download(payload: dict) -> tuple[str, str]:
    note_activity()
    url = validate_url(payload.get("url"))
    filename = safe_filename(payload.get("filename", "video.mp4"))
    headers = filter_request_headers(payload.get("headers", {}))
    task_id = uuid.uuid4().hex
    with TASKS_LOCK:
        if any(task["status"] in {"queued", "connecting", "downloading"} for task in TASKS.values()):
            raise DownloadError("已有下载任务正在进行，请稍后再试。")
        TASKS[task_id] = {
            "taskId": task_id,
            "status": "queued",
            "filename": filename,
            "bytes": 0,
            "totalBytes": None,
            "progress": None,
            "error": "",
        }
        CANCEL_EVENTS[task_id] = threading.Event()
    worker = threading.Thread(target=run_download, args=(task_id, url, headers, filename), daemon=True)
    worker.start()
    return task_id, filename


def cancel_download(task_id: str) -> bool:
    with TASKS_LOCK:
        event = CANCEL_EVENTS.get(task_id)
        if event is None:
            return False
        event.set()
        return True


class DownloaderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        # Request bodies can contain signed URLs or authentication headers.
        return

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except OSError as error:
            if is_client_disconnect(error):
                self.close_connection = True
                return
            raise

    def send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except OSError as error:
            if is_client_disconnect(error):
                self.close_connection = True
                return
            raise

    def do_GET(self):  # noqa: N802
        note_activity()
        parsed = urlsplit(self.path)
        if parsed.path == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True, "service": "local-downloader", "version": COMPANION_VERSION})
            return
        if parsed.path == "/status":
            task_id = parse_qs(parsed.query).get("id", [""])[0]
            task = task_snapshot(task_id)
            if task is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "任务不存在。"})
            else:
                self.send_json(HTTPStatus.OK, task)
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})

    def do_POST(self):  # noqa: N802
        note_activity()
        if urlsplit(self.path).path != "/download":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_JSON_BYTES:
                raise DownloadError("请求体大小无效。")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise DownloadError("请求体格式无效。")
            task_id, filename = create_download(payload)
            self.send_json(HTTPStatus.ACCEPTED, {"taskId": task_id, "filename": filename, "status": "queued"})
        except json.JSONDecodeError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "请求 JSON 无效。"})
        except DownloadError as error:
            self.send_json(HTTPStatus.CONFLICT, {"error": str(error)})
        except (KeyError, TypeError, ValueError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "下载参数无效。"})


def run_server() -> None:
    server = ThreadingHTTPServer((HOST, PORT), DownloaderHandler)
    server.timeout = 1
    log_message(f"Local downloader listening on http://{HOST}:{PORT}")
    try:
        while True:
            server.handle_request()
            if not has_active_tasks() and seconds_since_activity() >= IDLE_EXIT_SECONDS:
                log_message("Local downloader stopped after idle timeout.")
                break
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run_server()
