import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from companion.desktop_tool import convert_mp4_to_mp3, format_bytes, format_duration


class DesktopToolTests(unittest.TestCase):
    def test_format_helpers(self):
        self.assertEqual(format_bytes(1024 * 1024), "1.0 MB")
        self.assertEqual(format_duration(65), "01:05")
        self.assertEqual(format_duration(3661), "01:01:01")

    @unittest.skipUnless(shutil.which("ffmpeg.exe") and shutil.which("ffprobe.exe"), "FFmpeg not installed")
    def test_mp4_to_mp3_preserves_source_and_reports_progress(self):
        ffmpeg = shutil.which("ffmpeg.exe")
        ffprobe = shutil.which("ffprobe.exe")
        assert ffmpeg and ffprobe
        with TemporaryDirectory() as directory:
            input_path = Path(directory) / "sample.mp4"
            subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=160x120:r=10",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-shortest",
                    "-c:v",
                    "libx264",
                    "-c:a",
                    "aac",
                    str(input_path),
                ],
                check=True,
                capture_output=True,
            )
            source_size = input_path.stat().st_size
            progress = []
            output_path = convert_mp4_to_mp3(
                input_path,
                ffmpeg_path=Path(ffmpeg),
                ffprobe_path=Path(ffprobe),
                progress_callback=lambda percent, speed, eta: progress.append(percent),
            )
            self.assertTrue(input_path.is_file())
            self.assertEqual(input_path.stat().st_size, source_size)
            self.assertTrue(output_path.is_file())
            self.assertGreater(output_path.stat().st_size, 0)
            self.assertGreaterEqual(max(progress), 100)


if __name__ == "__main__":
    unittest.main()
