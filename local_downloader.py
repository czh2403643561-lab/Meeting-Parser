"""Small loopback-only streaming downloader for direct MP4 resources."""

from __future__ import annotations

import json
import os
import re
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, parse_qs
from urllib.request import HTTPRedirectHandler, Request, build_opener

HOST = "127.0.0.1"
PORT = 8765
CHUNK_SIZE = 1024 * 1024
MAX_JSON_BYTES = 256 * 1024
MAX_HEADER_VALUE_LENGTH = 8192

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


class DownloadError(Exception):
    """An expected download failure that is safe to return to the extension."""


def downloads_directory() -> Path:
    return Path.home() / "Downloads"


def safe_filename(value: str) -> str:
    """Return a filename confined to the Downloads directory and ending in .mp4."""
    if not isinstance(value, str):
        value = "video.mp4"
    value = value.replace("/", " ").replace("\\", " ")
    value = re.sub(r'[<>:"|?*\x00-\x1f]', " ", value)
    value = re.sub(r"\s+", " ", value).strip().strip(".")
    if not value:
        value = "video"
    if value.lower().endswith(".mp4"):
        return f"{value[:-4].rstrip()[:175] or 'video'}.mp4"
    return f"{value[:175]}.mp4"


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


def update_task(task_id: str, **changes: object) -> None:
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if task is not None:
            task.update(changes)


def task_snapshot(task_id: str) -> dict | None:
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        return dict(task) if task else None


def has_active_task() -> bool:
    with TASKS_LOCK:
        return any(task["status"] in {"queued", "downloading"} for task in TASKS.values())


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
    try:
        update_task(task_id, status="downloading")
        target = unique_target(filename)
        part = target.with_name(target.name + ".part")
        request = Request(url, headers=headers, method="GET")
        opener = build_opener(SafeRedirectHandler())

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
            content_length = response.headers.get("Content-Length")
            expected_size = int(content_length) if content_length and content_length.isdigit() else None

            total = 0
            with part.open("wb") as output:
                while True:
                    chunk = response.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    output.write(chunk)
                    total += len(chunk)
                    update_task(task_id, bytes=total)

            if expected_size is not None and total != expected_size:
                raise DownloadError("媒体响应不完整，未保存文件。")

        os.replace(part, target)
        update_task(task_id, status="complete", filename=target.name, bytes=total, error="")
    except Exception as error:  # The task must always become observable by the popup.
        if part is not None:
            try:
                part.unlink(missing_ok=True)
            except OSError:
                pass
        message = error.args[0] if isinstance(error, DownloadError) and error.args else "下载失败。"
        update_task(task_id, status="failed", error=str(message), filename=safe_filename(filename))


def create_download(payload: dict) -> tuple[str, str]:
    if has_active_task():
        raise DownloadError("已有下载任务正在进行，请稍后再试。")
    url = validate_url(payload.get("url"))
    filename = safe_filename(payload.get("filename", "video.mp4"))
    headers = filter_request_headers(payload.get("headers", {}))
    task_id = uuid.uuid4().hex
    with TASKS_LOCK:
        TASKS[task_id] = {
            "taskId": task_id,
            "status": "queued",
            "filename": filename,
            "bytes": 0,
            "error": "",
        }
    worker = threading.Thread(target=run_download, args=(task_id, url, headers, filename), daemon=True)
    worker.start()
    return task_id, filename


class DownloaderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002
        # Request bodies can contain signed URLs or authentication headers.
        return

    def send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True, "service": "local-downloader"})
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
    server = HTTPServer((HOST, PORT), DownloaderHandler)
    print(f"Local downloader listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run_server()
