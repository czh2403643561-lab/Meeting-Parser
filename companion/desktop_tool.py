"""Standalone Meeting Parser desktop tool."""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from tkinter import filedialog
import tkinter as tk
from tkinter import ttk
from typing import Callable


ProgressCallback = Callable[[float, str, str], None]
_SPEED_PATTERN = re.compile(r"^(?P<value>[0-9]+(?:\.[0-9]+)?)x$")


@dataclass
class ConversionTask:
    path: Path
    status: str = "等待"
    error: str = ""
    progress: float = 0.0
    speed: str = ""
    eta: str = ""


def bundled_binary(name: str) -> Path | None:
    candidates: list[Path] = []
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        candidates.append(Path(bundle_root) / "ffmpeg" / name)
    candidates.append(Path(__file__).resolve().parents[1] / "tools" / "ffmpeg" / name)
    from_path = shutil.which(name)
    if from_path:
        candidates.append(Path(from_path))
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def process_creation_flags() -> int:
    if sys.platform == "win32":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def config_file_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "MeetingParser" / "config.json"
    return Path.home() / ".meetingparser" / "config.json"


def load_output_folder() -> Path | None:
    try:
        payload = json.loads(config_file_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    output_folder = payload.get("outputFolder") if isinstance(payload, dict) else None
    if not isinstance(output_folder, str) or not output_folder.strip():
        return None
    return Path(output_folder)


def save_output_folder(output_folder: Path | None) -> None:
    path = config_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"outputFolder": str(output_folder) if output_folder else ""}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def format_bytes(value: int) -> str:
    if value < 1024 * 1024:
        return f"{value / 1024:.1f} KB"
    return f"{value / (1024 * 1024):.1f} MB"


def format_duration(seconds: float) -> str:
    if seconds < 0 or seconds != seconds:
        return "—"
    total = int(seconds)
    minutes, remainder = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{remainder:02d}"
    return f"{minutes:02d}:{remainder:02d}"


def probe_duration(ffprobe_path: Path, input_path: Path) -> float:
    result = subprocess.run(
        [
            str(ffprobe_path),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=process_creation_flags(),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "无法读取 MP4 时长。")
    try:
        duration = float(result.stdout.strip())
    except ValueError as error:
        raise RuntimeError("无法读取 MP4 时长。") from error
    if duration <= 0:
        raise RuntimeError("MP4 时长无效。")
    return duration


def convert_mp4_to_mp3(
    input_path: Path,
    *,
    output_directory: Path | None = None,
    ffmpeg_path: Path | None = None,
    ffprobe_path: Path | None = None,
    progress_callback: ProgressCallback | None = None,
) -> Path:
    ffmpeg_path = ffmpeg_path or bundled_binary("ffmpeg.exe")
    ffprobe_path = ffprobe_path or bundled_binary("ffprobe.exe")
    if not ffmpeg_path or not ffprobe_path:
        raise RuntimeError("本地 FFmpeg 组件缺失，请重新安装 Meeting Parser。")

    duration = probe_duration(ffprobe_path, input_path)
    if output_directory:
        output_directory.mkdir(parents=True, exist_ok=True)
        output_path = output_directory / f"{input_path.stem}.mp3"
    else:
        output_path = input_path.with_suffix(".mp3")
    command = [
        str(ffmpeg_path),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-i",
        str(input_path),
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-progress",
        "pipe:1",
        "-y",
        str(output_path),
    ]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=process_creation_flags(),
    )
    stderr_lines: list[str] = []

    def collect_stderr() -> None:
        if process.stderr:
            stderr_lines.extend(process.stderr.readlines())

    stderr_thread = threading.Thread(target=collect_stderr, daemon=True)
    stderr_thread.start()
    current_seconds = 0.0
    speed_text = ""
    try:
        if process.stdout:
            for line in process.stdout:
                key, _, value = line.strip().partition("=")
                if key == "out_time_ms":
                    current_seconds = max(0.0, float(value) / 1_000_000)
                    percent = min(100.0, current_seconds / duration * 100)
                    eta = ""
                    speed_match = _SPEED_PATTERN.match(speed_text)
                    if speed_match:
                        speed = float(speed_match.group("value"))
                        if speed > 0:
                            eta = format_duration((duration - current_seconds) / speed)
                    if progress_callback:
                        progress_callback(percent, speed_text, eta)
                elif key == "speed":
                    speed_text = value
                elif key == "progress" and value == "end" and progress_callback:
                    progress_callback(100.0, speed_text, "00:00")
    finally:
        process.wait()
        stderr_thread.join(timeout=2)
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()

    if process.returncode != 0:
        message = "".join(stderr_lines).strip() or "FFmpeg 转换失败。"
        raise RuntimeError(message[-1000:])
    if not output_path.is_file() or output_path.stat().st_size <= 0:
        raise RuntimeError("未生成有效 MP3 文件。")
    return output_path


class MeetingParserTool(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Meeting Parser 本地工具")
        self.geometry("860x650")
        self.minsize(720, 520)
        self.configure(background="#f6f8fb")
        self.tasks: list[ConversionTask] = []
        self.events: queue.Queue[tuple] = queue.Queue()
        self.conversion_running = False
        self.log_visible = False
        self.output_folder = load_output_folder()
        self._build_ui()
        self.after(100, self._poll_events)

    def _build_ui(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 18, "bold"))
        style.configure("Subtitle.TLabel", foreground="#5f6b7a")
        style.configure("Status.TLabel", foreground="#246b45")

        container = ttk.Frame(self, padding=24)
        container.pack(fill="both", expand=True)
        ttk.Label(container, text="Meeting Parser 本地工具", style="Title.TLabel").pack(anchor="w")
        ttk.Label(container, text="本地媒体处理工具", style="Subtitle.TLabel").pack(anchor="w", pady=(5, 18))

        feature_frame = ttk.LabelFrame(container, text="功能入口", padding=12)
        feature_frame.pack(fill="x")
        ttk.Button(feature_frame, text="添加 MP4 文件", command=self._add_files).pack(side="left")
        self.start_button = ttk.Button(feature_frame, text="开始转换", command=self._start_conversion)
        self.start_button.pack(side="left", padx=(10, 0))
        self.clear_button = ttk.Button(feature_frame, text="清空列表", command=self._clear_files)
        self.clear_button.pack(side="left", padx=(10, 0))
        ttk.Button(feature_frame, text="文件处理（预留）", state=tk.DISABLED).pack(side="right")

        output_frame = ttk.LabelFrame(container, text="输出位置", padding=10)
        output_frame.pack(fill="x", pady=(14, 0))
        ttk.Label(output_frame, text="当前路径：").pack(side="left")
        self.output_folder_var = tk.StringVar()
        ttk.Label(
            output_frame,
            textvariable=self.output_folder_var,
            style="Subtitle.TLabel",
        ).pack(side="left", fill="x", expand=True, padx=(4, 12))
        ttk.Button(output_frame, text="选择文件夹", command=self._choose_output_folder).pack(side="left")
        ttk.Button(output_frame, text="打开文件夹", command=self._open_output_folder).pack(
            side="left", padx=(8, 0)
        )
        self._refresh_output_folder()

        list_frame = ttk.LabelFrame(container, text="MP4 转 MP3", padding=10)
        list_frame.pack(fill="both", expand=True, pady=(14, 0))
        columns = ("name", "size", "status")
        self.file_list = ttk.Treeview(list_frame, columns=columns, show="headings", height=8)
        self.file_list.heading("name", text="文件名")
        self.file_list.heading("size", text="文件大小")
        self.file_list.heading("status", text="状态")
        self.file_list.column("name", width=470, anchor="w")
        self.file_list.column("size", width=110, anchor="e")
        self.file_list.column("status", width=110, anchor="center")
        scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=self.file_list.yview)
        self.file_list.configure(yscrollcommand=scrollbar.set)
        self.file_list.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        summary = ttk.LabelFrame(container, text="任务状态", padding=10)
        summary.pack(fill="x", pady=(14, 0))
        self.total_label = ttk.Label(summary, text="总任务数量：0")
        self.total_label.pack(side="left", padx=(0, 20))
        self.complete_label = ttk.Label(summary, text="完成数量：0")
        self.complete_label.pack(side="left", padx=(0, 20))
        self.failed_label = ttk.Label(summary, text="失败数量：0")
        self.failed_label.pack(side="left", padx=(0, 20))
        self.current_label = ttk.Label(summary, text="当前任务：—")
        self.current_label.pack(side="left")

        progress_frame = ttk.LabelFrame(container, text="当前进度", padding=10)
        progress_frame.pack(fill="x", pady=(14, 0))
        self.progress_task_label = ttk.Label(progress_frame, text="当前文件：—")
        self.progress_task_label.pack(anchor="w")
        progress_row = ttk.Frame(progress_frame)
        progress_row.pack(fill="x", pady=(8, 0))
        self.progress_bar = ttk.Progressbar(progress_row, maximum=100)
        self.progress_bar.pack(side="left", fill="x", expand=True)
        self.progress_label = ttk.Label(progress_row, text="0%", width=7, anchor="e")
        self.progress_label.pack(side="right", padx=(10, 0))
        self.progress_detail = ttk.Label(progress_frame, text="速度：—    预计剩余：—", style="Subtitle.TLabel")
        self.progress_detail.pack(anchor="w", pady=(6, 0))

        log_header = ttk.Frame(container)
        log_header.pack(fill="x", pady=(14, 0))
        self.log_button = ttk.Button(log_header, text="展开日志", command=self._toggle_logs)
        self.log_button.pack(anchor="w")
        self.log_text = tk.Text(container, height=6, state="disabled", wrap="word")

        self.status_label = ttk.Label(container, text="请选择 MP4 文件开始。", style="Status.TLabel")
        self.status_label.pack(anchor="w", pady=(10, 0))
        self._refresh_summary()

    def _add_files(self) -> None:
        paths = filedialog.askopenfilenames(
            title="选择 MP4 文件",
            filetypes=[("MP4 视频", "*.mp4"), ("所有文件", "*.*")],
        )
        known = {task.path.resolve() for task in self.tasks}
        for raw_path in paths:
            path = Path(raw_path)
            if path.suffix.lower() != ".mp4" or not path.is_file() or path.resolve() in known:
                continue
            self.tasks.append(ConversionTask(path=path))
            known.add(path.resolve())
        self._refresh_file_list()
        self._refresh_summary()

    def _clear_files(self) -> None:
        if self.conversion_running:
            return
        self.tasks.clear()
        self._refresh_file_list()
        self._refresh_summary()
        self.status_label.configure(text="请选择 MP4 文件开始。")

    def _refresh_output_folder(self) -> None:
        self.output_folder_var.set(str(self.output_folder) if self.output_folder else "MP4 所在目录（默认）")

    def _choose_output_folder(self) -> None:
        initial_directory = str(self.output_folder) if self.output_folder else ""
        selected = filedialog.askdirectory(
            title="选择 MP3 输出文件夹",
            initialdir=initial_directory or str(Path.home()),
        )
        if not selected:
            return
        self.output_folder = Path(selected).resolve()
        try:
            save_output_folder(self.output_folder)
        except OSError as error:
            self.status_label.configure(text=f"输出目录设置未保存：{error}")
            return
        self._refresh_output_folder()
        self.status_label.configure(text=f"已设置输出目录：{self.output_folder}")

    def _open_output_folder(self) -> None:
        output_folder = self.output_folder
        if output_folder is None:
            output_folder = self.tasks[0].path.parent if self.tasks else None
        if output_folder is None:
            self.status_label.configure(text="请先选择输出文件夹或添加 MP4 文件。")
            return
        try:
            output_folder.mkdir(parents=True, exist_ok=True)
            if sys.platform == "win32":
                os.startfile(str(output_folder))
            else:
                subprocess.Popen(["xdg-open", str(output_folder)])
        except OSError as error:
            self.status_label.configure(text=f"无法打开输出文件夹：{error}")

    def _start_conversion(self) -> None:
        if self.conversion_running:
            return
        if not self.tasks:
            self.status_label.configure(text="请先添加至少一个 MP4 文件。")
            return
        for task in self.tasks:
            task.status = "等待"
            task.error = ""
            task.progress = 0
            task.speed = ""
            task.eta = ""
        self.conversion_running = True
        self.start_button.configure(state=tk.DISABLED)
        self.clear_button.configure(state=tk.DISABLED)
        self._refresh_file_list()
        self._refresh_summary()
        threading.Thread(target=self._convert_all, daemon=True).start()

    def _convert_all(self) -> None:
        for index, task in enumerate(self.tasks):
            self.events.put(("start", index))
            try:
                def on_progress(percent: float, speed: str, eta: str) -> None:
                    self.events.put(("progress", index, percent, speed, eta))

                convert_mp4_to_mp3(
                    task.path,
                    output_directory=self.output_folder,
                    progress_callback=on_progress,
                )
            except Exception as error:  # noqa: BLE001
                self.events.put(("complete", index, False, str(error)))
            else:
                self.events.put(("complete", index, True, ""))
        self.events.put(("finished",))

    def _poll_events(self) -> None:
        try:
            while True:
                event = self.events.get_nowait()
                kind = event[0]
                if kind == "start":
                    index = event[1]
                    task = self.tasks[index]
                    task.status = "转换中"
                    task.progress = 0
                    self.progress_task_label.configure(text=f"当前文件：{task.path.name}")
                    self.current_label.configure(text=f"当前任务：{task.path.name}")
                    self.status_label.configure(text=f"正在转换：{task.path.name}")
                    self._refresh_file_list()
                    self._write_log(task.path.name, "开始转换")
                elif kind == "progress":
                    index, percent, speed, eta = event[1:]
                    task = self.tasks[index]
                    task.progress = percent
                    task.speed = speed
                    task.eta = eta
                    self.progress_bar.configure(value=percent)
                    self.progress_label.configure(text=f"{percent:.0f}%")
                    self.progress_detail.configure(text=f"速度：{speed or '—'}    预计剩余：{eta or '—'}")
                elif kind == "complete":
                    index, success, error = event[1:]
                    task = self.tasks[index]
                    task.status = "完成" if success else "失败"
                    task.error = error
                    task.progress = 100 if success else task.progress
                    self._write_log(task.path.name, "转换完成" if success else f"转换失败：{error}")
                    if not success:
                        self.status_label.configure(text=f"转换失败：{task.path.name}")
                    self._refresh_file_list()
                    self._refresh_summary()
                elif kind == "finished":
                    self.conversion_running = False
                    self.start_button.configure(state=tk.NORMAL)
                    self.clear_button.configure(state=tk.NORMAL)
                    failed = sum(task.status == "失败" for task in self.tasks)
                    self.current_label.configure(text="当前任务：—")
                    self.status_label.configure(text="转换完成，有失败任务。" if failed else "全部转换完成。")
                    self._refresh_summary()
        except queue.Empty:
            pass
        self.after(100, self._poll_events)

    def _refresh_file_list(self) -> None:
        for item in self.file_list.get_children():
            self.file_list.delete(item)
        for task in self.tasks:
            try:
                size = format_bytes(task.path.stat().st_size)
            except OSError:
                size = "—"
            self.file_list.insert("", "end", values=(task.path.name, size, task.status))

    def _refresh_summary(self) -> None:
        total = len(self.tasks)
        complete = sum(task.status == "完成" for task in self.tasks)
        failed = sum(task.status == "失败" for task in self.tasks)
        self.total_label.configure(text=f"总任务数量：{total}")
        self.complete_label.configure(text=f"完成数量：{complete}")
        self.failed_label.configure(text=f"失败数量：{failed}")

    def _toggle_logs(self) -> None:
        self.log_visible = not self.log_visible
        if self.log_visible:
            self.log_text.pack(fill="both", expand=False, pady=(6, 0))
            self.log_button.configure(text="收起日志")
        else:
            self.log_text.pack_forget()
            self.log_button.configure(text="展开日志")

    def _write_log(self, filename: str, message: str) -> None:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{timestamp}] {filename}：{message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")


def main() -> None:
    MeetingParserTool().mainloop()


if __name__ == "__main__":
    main()
