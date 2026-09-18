import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from companion.native_host import COMPANION_VERSION, failed_payload, status_payload
from local_downloader import create_download, task_snapshot


ROOT = Path(__file__).resolve().parents[1]
HOST_SCRIPT = ROOT / "companion" / "native_host.py"
HOST_EXE = ROOT / "dist" / "companion" / "MeetingParserHost.exe"


def frame(value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def read_frame(stream):
    header = stream.read(4)
    if len(header) != 4:
        return None
    length = struct.unpack("<I", header)[0]
    return json.loads(stream.read(length).decode("utf-8"))


class NativeHostProtocolTests(unittest.TestCase):
    def assert_hello(self, command):
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            process.stdin.write(frame({"type": "hello"}))
            process.stdin.flush()
            self.assertEqual(
                read_frame(process.stdout),
                {"type": "hello", "version": COMPANION_VERSION},
            )
        finally:
            process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(process.returncode, 0)

    def test_hello_response_uses_version_without_starting_a_server(self):
        self.assert_hello([sys.executable, str(HOST_SCRIPT)])

    def test_invalid_start_download_returns_failure_without_echoing_url(self):
        process = subprocess.Popen(
            [sys.executable, str(HOST_SCRIPT)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            process.stdin.write(frame({"type": "hello"}))
            process.stdin.write(frame({
                "type": "startDownload",
                "requestId": "request-invalid",
                "url": "file:///secret/video.mp4?token=secret",
                "filename": "video.mp4",
                "headers": {"Cookie": "secret-cookie", "Authorization": "Bearer secret"},
            }))
            process.stdin.flush()
            self.assertEqual(read_frame(process.stdout)["type"], "hello")
            response = read_frame(process.stdout)
            self.assertEqual(response["status"], "failed")
            self.assertNotIn("secret", json.dumps(response))
        finally:
            process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

    @unittest.skipUnless(HOST_EXE.is_file(), "frozen Host not built")
    def test_frozen_host_hello_response(self):
        self.assert_hello([str(HOST_EXE)])

    def test_status_payload_contains_no_request_secrets(self):
        payload = status_payload("request-1", {
            "status": "downloading",
            "filename": "课程.mp4",
            "bytes": 5,
            "totalBytes": 10,
            "progress": 50,
            "error": "",
        })
        self.assertEqual(payload["requestId"], "request-1")
        self.assertNotIn("url", payload)
        self.assertNotIn("cookie", payload)
        self.assertNotIn("authorization", payload)

    def test_rejected_second_task_is_a_terminal_status(self):
        payload = failed_payload("request-2", "已有下载任务正在进行，请稍后再试。")
        self.assertEqual(payload["type"], "downloadStatus")
        self.assertEqual(payload["status"], "failed")

    def test_shared_streaming_core_reaches_complete_and_writes_downloads(self):
        body = b"mp4-test-data" * 1024

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}), patch("local_downloader.downloads_directory", return_value=Path(directory)):
                task_id, filename = create_download({
                    "url": f"http://127.0.0.1:{server.server_port}/video.mp4",
                    "filename": "标题：测试.mp4",
                    "headers": {},
                })
                deadline = time.monotonic() + 5
                snapshot = task_snapshot(task_id)
                while snapshot and snapshot["status"] not in {"complete", "failed"} and time.monotonic() < deadline:
                    time.sleep(0.02)
                    snapshot = task_snapshot(task_id)
                self.assertEqual(snapshot["status"], "complete")
                self.assertEqual((Path(directory) / filename).read_bytes(), body)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
