"""Cross-version evidence admits one null column, never ignores business routes."""
import hashlib
import importlib.util
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("upgrade_evidence", ROOT / "scripts/smoke-customer-upgrade.py")
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeDatabaseEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.before = Path(self.temp.name).resolve() / "before.db"
        self.after = Path(self.temp.name).resolve() / "after.db"
        with sqlite3.connect(self.before) as connection:
            for table in sorted(upgrade.vault.REQUIRED_TABLES | {"pricing_fixture"}):
                connection.execute(f'CREATE TABLE "{table}" (id text PRIMARY KEY, value text)')
                connection.execute(f'INSERT INTO "{table}" VALUES (?, ?)', ("synthetic-id", "private-synthetic-business-value"))
        shutil.copyfile(self.before, self.after)

    def tearDown(self):
        self.temp.cleanup()

    def sql(self, path, statement, args=()):
        with sqlite3.connect(path) as connection:
            connection.execute(statement, args)

    def check(self, source="2.12.11", target="2.12.13"):
        return upgrade.assert_business_database_preserved(self.before, self.after, source, target)

    def add_routes(self, declaration="text"):
        self.sql(self.after, "ALTER TABLE gateway_api_keys ADD COLUMN model_routes " + declaration)

    def test_identical_snapshots_remain_strict_without_normalization(self):
        self.assertEqual(self.check("2.12.11", "2.12.11"), [])

    def test_new_column_must_really_be_added_at_the_version_boundary(self):
        with self.assertRaisesRegex(AssertionError, "unexpected_model_routes_schema"):
            self.check()

    def test_nullable_column_addition_preserves_snapshots_and_original_vault_evidence(self):
        self.add_routes()
        digests = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.before, self.after)]
        self.assertNotEqual(upgrade.vault.database_evidence(self.before), upgrade.vault.database_evidence(self.after))
        self.assertEqual(self.check("2.11.7"), ["nullable_api_key_model_routes_added"])
        self.assertEqual(digests, [hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.before, self.after)])
        self.assertNotEqual(upgrade.vault.database_evidence(self.before), upgrade.vault.database_evidence(self.after))

    def test_typeorm_column_position_is_not_business_data(self):
        with sqlite3.connect(self.after) as connection:
            connection.execute("ALTER TABLE gateway_api_keys RENAME TO old_keys")
            connection.execute("CREATE TABLE gateway_api_keys (id text PRIMARY KEY, model_routes text, value text)")
            connection.execute("INSERT INTO gateway_api_keys (id,value) SELECT id,value FROM old_keys")
            connection.execute("DROP TABLE old_keys")
        self.assertEqual(self.check(), ["nullable_api_key_model_routes_added"])

    def test_old_key_cannot_gain_even_an_empty_serialized_binding(self):
        self.add_routes()
        for value in ("[]", "null", '[{"model":"synthetic-model"}]'):
            with self.subTest(value=value):
                self.sql(self.after, "UPDATE gateway_api_keys SET model_routes=?", (value,))
                with self.assertRaisesRegex(AssertionError, "legacy_keys_were_bound"):
                    self.check()

    def test_original_business_cells_and_rows_are_all_still_checked(self):
        self.add_routes()
        original = self.after.read_bytes()
        changes = [
            "UPDATE gateway_api_keys SET value='changed'",
            "UPDATE pricing_fixture SET value='changed'",
            "DELETE FROM call_logs",
            "DELETE FROM gateway_api_keys",
            "INSERT INTO gateway_api_keys (id,value) VALUES ('extra','key')",
            "ALTER TABLE gateway_api_keys ADD COLUMN unrelated text",
            "DROP TABLE pricing_fixture",
        ]
        for statement in changes:
            with self.subTest(statement=statement):
                self.after.write_bytes(original)
                self.sql(self.after, statement)
                with self.assertRaises(AssertionError):
                    self.check()

    def test_existing_bound_routes_must_match_and_are_not_projected_away(self):
        for path in (self.before, self.after):
            self.sql(path, "ALTER TABLE gateway_api_keys ADD COLUMN model_routes text")
            self.sql(path, "UPDATE gateway_api_keys SET model_routes=?", ('[{"model":"synthetic-model","strategy":"round_robin"}]',))
        self.assertEqual(self.check("2.12.12"), [])
        for value in (None, "[]", '[{"model":"different"}]'):
            with self.subTest(value=value):
                self.sql(self.after, "UPDATE gateway_api_keys SET model_routes=?", (value,))
                with self.assertRaises(AssertionError):
                    self.check("2.12.12")
                with self.assertRaisesRegex(AssertionError, "unreviewed_business_database_change"):
                    self.check("2.12.11")

    def test_only_reviewed_version_boundary_and_column_shape_are_accepted(self):
        original = self.after.read_bytes()
        for declaration in ("integer", "text NOT NULL DEFAULT '[]'", "text DEFAULT '[]'"):
            with self.subTest(declaration=declaration):
                self.after.write_bytes(original)
                self.add_routes(declaration)
                with self.assertRaisesRegex(AssertionError, "unexpected_model_routes_schema"):
                    self.check()
        self.after.write_bytes(original)
        self.add_routes()
        for source, target in (("2.12.11", "2.12.11"), ("2.12.12", "2.12.13")):
            with self.subTest(source=source, target=target), self.assertRaisesRegex(AssertionError, "unreviewed_business_database_change"):
                self.check(source, target)

    def test_uncheckpointed_snapshot_is_rejected_before_projection(self):
        self.add_routes()
        Path(str(self.after) + "-wal").write_bytes(b"uncheckpointed-synthetic-wal")
        with self.assertRaises(upgrade.vault.VaultError):
            self.check()
