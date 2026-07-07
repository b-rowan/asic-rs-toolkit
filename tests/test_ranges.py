from unittest import TestCase

from asic_rs_toolkit.ranges import estimate_range_size, iter_ips, parse_range_expression


class RangeParsingTests(TestCase):
    def test_single_ip_range(self) -> None:
        octets = parse_range_expression("192.168.1.10")

        self.assertEqual([octet.as_pyasic_arg() for octet in octets], ["192", "168", "1", "10"])
        self.assertEqual(estimate_range_size("192.168.1.10"), 1)

    def test_expanded_octet_ranges(self) -> None:
        self.assertEqual(estimate_range_size("10.0-1.2.3-4"), 4)
        self.assertEqual(
            iter_ips("10.0-1.2.3-4"),
            ["10.0.2.3", "10.0.2.4", "10.1.2.3", "10.1.2.4"],
        )

    def test_invalid_range_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_range_expression("192.168.1")
        with self.assertRaises(ValueError):
            parse_range_expression("192.168.1.300")
        with self.assertRaises(ValueError):
            parse_range_expression("192.168.10-2.1")
