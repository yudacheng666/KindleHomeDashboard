"""Private startup settings: no real schedule or network calls."""
from argparse import Namespace
import unittest
from dashboard.__main__ import apply_private_settings, window_arg


def args(**overrides):
    return Namespace(**({"enable_bus":False,"window":[],"timezone":None,"daily_limit":None}|overrides))


class PrivateSettingsTests(unittest.TestCase):
    def test_default_off(self):
        a=apply_private_settings(args(),{})
        self.assertFalse(a.enable_bus)
        self.assertEqual(a.window,[])
        self.assertEqual(a.timezone,"Asia/Shanghai")
        self.assertEqual(a.daily_limit,1000)

    def test_explicit_environment(self):
        a=apply_private_settings(args(),{"KHD_BUS_ENABLED":"1",
            "KHD_BUS_WINDOWS":"1:13:00-14:00;6:23:00-01:00",
            "KHD_TIMEZONE":"UTC","KHD_BUS_DAILY_LIMIT":"42"})
        self.assertTrue(a.enable_bus)
        self.assertEqual(a.window,[window_arg("1:13:00-14:00"),window_arg("6:23:00-01:00")])
        self.assertEqual(a.timezone,"UTC")
        self.assertEqual(a.daily_limit,42)

    def test_invalid_values_fail_closed(self):
        for env in ({"KHD_BUS_ENABLED":"yes"},{"KHD_BUS_ENABLED":"1"},
                    {"KHD_BUS_WINDOWS":"invalid"},{"KHD_BUS_WINDOWS":"1:12:00-13:00;"},
                    {"KHD_TIMEZONE":"not/a/zone"},{"KHD_BUS_DAILY_LIMIT":"0"},
                    {"KHD_BUS_DAILY_LIMIT":"1001"},{"KHD_BUS_DAILY_LIMIT":"true"},
                    {"KHD_BUS_WINDOWS":"x"*2049}):
            with self.subTest(keys=list(env)):
                with self.assertRaises(ValueError):
                    apply_private_settings(args(),env)

    def test_existing_cli_and_conflict(self):
        a=apply_private_settings(args(enable_bus=True,window=[window_arg("2:15:00-16:00")],
                                      timezone="UTC",daily_limit=20),{})
        self.assertTrue(a.enable_bus)
        self.assertEqual(a.daily_limit,20)
        with self.assertRaises(ValueError):
            apply_private_settings(args(window=[window_arg("2:15:00-16:00")]),
                                   {"KHD_BUS_WINDOWS":"1:13:00-14:00"})

if __name__=="__main__":
    unittest.main()
