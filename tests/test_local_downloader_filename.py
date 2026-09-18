import unittest

from local_downloader import safe_filename


class SafeFilenameTests(unittest.TestCase):
    def test_preserves_chinese_punctuation_and_replaces_windows_characters(self):
        self.assertEqual(
            safe_filename('第14章：A/B?C*D|E<测试>"'),
            "第14章：A／B？C＊D｜E＜测试＞＂.mp4",
        )

    def test_does_not_use_the_old_short_truncation(self):
        filename = safe_filename("长" * 180)
        self.assertEqual(len(filename.removesuffix(".mp4")), 180)

    def test_removes_controls_and_trailing_dots(self):
        self.assertEqual(safe_filename("  标题\x00.  "), "标题.mp4")


if __name__ == "__main__":
    unittest.main()
