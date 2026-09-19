"""Small standalone desktop shell for future Meeting Parser tools."""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk


class MeetingParserTool(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Meeting Parser 本地工具")
        self.geometry("620x420")
        self.minsize(520, 360)
        self.configure(background="#f6f8fb")
        self._build_ui()

    def _build_ui(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 18, "bold"))
        style.configure("Subtitle.TLabel", foreground="#5f6b7a")
        style.configure("Card.TLabelframe", padding=14)
        style.configure("Status.TLabel", foreground="#246b45")

        container = ttk.Frame(self, padding=28)
        container.pack(fill="both", expand=True)

        ttk.Label(container, text="Meeting Parser 本地工具", style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            container,
            text="桌面处理工具框架，后续功能将在这里运行。",
            style="Subtitle.TLabel",
        ).pack(anchor="w", pady=(6, 24))

        feature_frame = ttk.LabelFrame(container, text="功能入口", style="Card.TLabelframe")
        feature_frame.pack(fill="x")
        feature_frame.columnconfigure(0, weight=1)
        feature_frame.columnconfigure(1, weight=1)

        self._add_placeholder(feature_frame, 0, "MP4 转 MP3", "音频转换模块预留")
        self._add_placeholder(feature_frame, 1, "文件处理", "文件处理模块预留")

        status_frame = ttk.LabelFrame(container, text="状态", style="Card.TLabelframe")
        status_frame.pack(fill="both", expand=True, pady=(20, 0))
        ttk.Label(status_frame, text="工具已启动，功能模块待接入。", style="Status.TLabel").pack(anchor="w")

    @staticmethod
    def _add_placeholder(parent: ttk.LabelFrame, column: int, title: str, description: str) -> None:
        frame = ttk.Frame(parent, padding=8)
        frame.grid(row=0, column=column, sticky="nsew")
        ttk.Label(frame, text=title, font=("Microsoft YaHei UI", 12, "bold")).pack(anchor="w")
        ttk.Label(frame, text=description, style="Subtitle.TLabel").pack(anchor="w", pady=(5, 10))
        ttk.Button(frame, text="即将提供", state=tk.DISABLED).pack(anchor="w")


def main() -> None:
    MeetingParserTool().mainloop()


if __name__ == "__main__":
    main()
