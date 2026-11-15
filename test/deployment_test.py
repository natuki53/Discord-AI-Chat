"""Exercise CI gating and real filesystem/SQLite rollback without touching Docker."""

from contextlib import closing
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


spec = importlib.util.spec_from_file_location("production_deploy", Path(__file__).parents[1] / "deploy/production_deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
SHA = "a" * 40


def workflow(**changes):
    return {"id": 1, "run_attempt": 1, "head_sha": SHA, "head_branch": "main", "event": "push",
            "path": ".github/workflows/ci.yml", "status": "completed", "conclusion": "success", **changes}


class GateTests(unittest.TestCase):
    def test_exact_successful_main_push_is_required(self):
        self.assertTrue(deploy.successful_main_run({"workflow_runs": [workflow()]}, SHA))
        for changes in ({"head_sha": "b" * 40}, {"event": "pull_request"}, {"head_branch": "feature"},
                        {"path": ".github/workflows/other.yml"}, {"status": "in_progress"}, {"conclusion": "failure"}):
            self.assertFalse(deploy.successful_main_run({"workflow_runs": [workflow(**changes)]}, SHA), changes)
        self.assertFalse(deploy.successful_main_run({}, SHA))

    def test_latest_run_and_rerun_override_previous_success(self):
        self.assertFalse(deploy.successful_main_run({"workflow_runs": [workflow(), workflow(id=2, conclusion="failure")]}, SHA))
        self.assertFalse(deploy.successful_main_run({"workflow_runs": [workflow(), workflow(run_attempt=2, status="in_progress")]}, SHA))

    def test_public_api_has_no_credentials_and_filters_exact_sha(self):
        def response(request, timeout):
            self.assertNotIn("Authorization", request.headers)
            self.assertIn(f"head_sha={SHA}", request.full_url)
            self.assertEqual(timeout, 20)
            return io.StringIO(json.dumps({"workflow_runs": [workflow()]}))
        with patch.object(deploy.urllib.request, "urlopen", side_effect=response):
            self.assertTrue(deploy.check_ci("owner/repository", SHA))

    def test_api_failure_never_implies_success(self):
        for status in (403, 404, 429, 500):
            error = urllib.error.HTTPError("https://api.github.com", status, "failed", {}, None)
            with patch.object(deploy.urllib.request, "urlopen", side_effect=error):
                if status == 404:
                    self.assertFalse(deploy.check_ci("owner/repository", SHA))
                else:
                    with self.assertRaises(RuntimeError):
                        deploy.check_ci("owner/repository", SHA)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "app"
        self.source = self.root / "payload"
        for root, text in ((self.app, "old"), (self.source, "new")):
            root.mkdir()
            for name in deploy.APP_DIRS:
                (root / name).mkdir()
                (root / name / "module.js").write_text(text)
            for name in deploy.APP_FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
        (self.app / "data/backups").mkdir(parents=True)
        self.database = self.app / "data/bot.sqlite3"
        with closing(sqlite3.connect(self.database)) as database:
            database.executescript("""
                CREATE TABLE channels(guild_id,channel_id,configured_mode,mode_override,previous_mode,version,context_revision);
                INSERT INTO channels VALUES('g','c','ambient','ambient','ambient',1,1);
                CREATE TABLE messages(content);
                INSERT INTO messages VALUES('before');
            """)
        self.config = {"repository": "owner/repository", "app_root": str(self.app),
                       "state_root": str(self.root / "state"), "release_root": str(self.root / "releases")}
        self.agent = deploy.Deployment(self.config)
        self.agent.latest_main = lambda: SHA
        self.agent.container_checks = lambda *_: None
        self.agent.wait_ready = lambda *_: None
        self.commands = []
        self.agent.compose = self.compose
        self.fail_registration = False
        self.fail_startup = False

    def fake_run(self, *args, **kwargs):
        self.commands.append(args)
        if args[:2] == ("git", "--git-dir") and "archive" in args:
            target = next(arg.removeprefix("--output=") for arg in args if arg.startswith("--output="))
            with tarfile.open(target, "w") as archive:
                for file in self.source.rglob("*"):
                    archive.add(file, arcname=str(file.relative_to(self.source)), recursive=False)
        if args[:2] == ("docker", "inspect"):
            return json.dumps([{"Image": "old-image"}])
        if args[:3] == ("docker", "image", "inspect"):
            return json.dumps([{"Id": "new-image"}])
        return ""

    def compose(self, *args, data=None):
        self.commands.append(("compose", *args))
        if deploy.BACKUP_COMMANDS in args:
            return "[]"
        if "scripts/register-commands.js" in args and self.fail_registration:
            self.fail_registration = False
            with closing(sqlite3.connect(self.database)) as database:
                database.execute("INSERT INTO messages VALUES('during-cutover')")
                database.execute("UPDATE channels SET mode_override='paused'")
                database.commit()
            raise RuntimeError("registration failure")
        return ""

    def test_success_publishes_exact_source_and_state(self):
        with patch.object(deploy, "run", side_effect=self.fake_run):
            self.agent.deploy(SHA)
        self.assertEqual((self.app / "src/module.js").read_text(), "new")
        self.assertEqual(self.agent.state["deployed_sha"], SHA)
        self.assertTrue(any("--check" in command for command in self.commands))

    def test_failed_registration_restores_code_modes_and_registry_but_keeps_messages(self):
        self.fail_registration = True
        with patch.object(deploy, "run", side_effect=self.fake_run):
            with self.assertRaisesRegex(RuntimeError, "registration"):
                self.agent.deploy(SHA)
        self.assertEqual((self.app / "src/module.js").read_text(), "old")
        self.assertEqual((self.app / "compose.yaml").read_text(), "old")
        self.assertTrue(any(deploy.RESTORE_COMMANDS in command for command in self.commands))
        with closing(sqlite3.connect(self.database)) as database:
            self.assertEqual(database.execute("SELECT mode_override FROM channels").fetchone()[0], "ambient")
            self.assertEqual(database.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 2)
        self.assertNotIn("deployed_sha", self.agent.state)

    def test_failed_preflight_never_stops_the_bot(self):
        def fail(*_):
            raise RuntimeError("preflight failure")
        self.agent.container_checks = fail
        with patch.object(deploy, "run", side_effect=self.fake_run):
            with self.assertRaises(RuntimeError):
                self.agent.deploy(SHA)
        self.assertFalse(any(command[:2] == ("compose", "stop") for command in self.commands))
        self.assertEqual((self.app / "src/module.js").read_text(), "old")

    def test_main_advancing_during_preflight_does_not_publish_old_commit(self):
        values = iter([SHA, "b" * 40])
        self.agent.latest_main = lambda: next(values)
        with patch.object(deploy, "run", side_effect=self.fake_run):
            self.agent.deploy(SHA)
        self.assertFalse(any(command[:2] == ("compose", "stop") for command in self.commands))

    def test_ci_failure_and_rate_backoff_do_not_deploy(self):
        with patch.object(deploy, "check_ci", return_value=False) as checks:
            self.agent.once()
            self.agent.once()
        self.assertEqual(checks.call_count, 1)
        self.assertFalse(self.commands)
        self.assertEqual(self.agent.state["pending_sha"], SHA)

    def test_ci_network_failure_records_backoff(self):
        with patch.object(deploy, "check_ci", side_effect=RuntimeError("offline")):
            with self.assertRaises(RuntimeError):
                self.agent.once()
        self.assertGreater(self.agent.state["next_ci_check"], deploy.time.time() + 800)
        self.assertFalse(self.commands)

    def test_failed_deployment_requires_explicit_retry(self):
        def fail(_):
            raise RuntimeError("deploy failed")
        self.agent.deploy = fail
        with patch.object(deploy, "check_ci", return_value=True) as checks:
            with self.assertRaises(RuntimeError):
                self.agent.once()
            self.agent.once()
        self.assertEqual(checks.call_count, 1)
        self.assertEqual(self.agent.state["failed_sha"], SHA)

    def test_unchanged_deployed_revision_makes_no_api_calls(self):
        self.agent.state["deployed_sha"] = SHA
        with patch.object(deploy, "check_ci") as checks:
            self.agent.once()
        checks.assert_not_called()

    def test_invalid_paths_and_repository_are_rejected(self):
        for change in ({"repository": "owner/repo?token=secret"}, {"state_root": str(self.app / "data")},
                       {"release_root": str(self.root)}, {"release_root": str(self.app)}):
            with self.assertRaises(ValueError):
                deploy.validate_config({**self.config, **change})

    def test_archive_traversal_and_links_are_rejected(self):
        for name, link in (("../outside", False), ("src/link", True)):
            archive = self.root / "unsafe.tar"
            with tarfile.open(archive, "w") as package:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc/passwd"
                package.addfile(member)
            with self.assertRaises(ValueError):
                deploy.extract_source(archive, self.root / "output")

    def test_verification_cleanup_only_removes_its_database_files(self):
        directory = self.root / "verify"
        directory.mkdir()
        for name in ("bot.sqlite3", "bot.sqlite3-shm", "bot.sqlite3-wal", "keep.txt"):
            (directory / name).write_text("test")
        deploy.remove_verification_database(directory)
        self.assertEqual([file.name for file in directory.iterdir()], ["keep.txt"])

    def test_recover_interrupted_cutover_restores_the_previous_source(self):
        def interrupted(image):
            if image == "new-image":
                raise KeyboardInterrupt()
        self.agent.wait_ready = interrupted
        with patch.object(deploy, "run", side_effect=self.fake_run):
            with self.assertRaises(KeyboardInterrupt):
                self.agent.deploy(SHA)
            self.assertTrue(self.agent.pending_path.exists())
            self.agent.recover()
        self.assertEqual((self.app / "src/module.js").read_text(), "old")
        self.assertFalse(self.agent.pending_path.exists())

    def test_completed_cutover_is_not_rolled_back_after_state_was_saved(self):
        self.agent.state["deployed_sha"] = SHA
        deploy.save_json(self.agent.pending_path, {"sha": SHA})
        self.agent.recover()
        self.assertFalse(self.agent.pending_path.exists())
        self.assertFalse(self.commands)

    def test_backup_retention_does_not_delete_manual_or_new_snapshots(self):
        directory = self.app / "data/backups"
        old = directory / "bot-2020-01-01T00-00-00-autodeploy.sqlite3"
        new = directory / "bot-2026-11-15T00-00-00-autodeploy.sqlite3"
        manual = directory / "bot-2020-01-01T00-00-00-manual.sqlite3"
        for path in (old, new, manual):
            path.write_text("snapshot")
        os.utime(old, (0, 0))
        os.utime(manual, (0, 0))
        self.agent.prune_backups()
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())
        self.assertTrue(manual.exists())


if __name__ == "__main__":
    unittest.main()
