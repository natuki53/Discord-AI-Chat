"""Pull verified main revisions; deploy only the bot and roll back failed cutovers."""

import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request


APP_FILES = ("package.json", "package-lock.json", "Dockerfile", ".dockerignore",
             "compose.yaml", "config/bot.example.yaml")
APP_DIRS = ("src", "scripts")
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
BACKUP_COMMANDS = """
import fs from 'node:fs';import {REST,Routes} from 'discord.js';import {loadConfig} from './src/config/load-config.js';
const {config}=loadConfig();const rest=new REST({version:'10'}).setToken(process.env.DISCORD_BOT_TOKEN);
const result=await rest.get(Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID,config.discord.guildId));
const fields=['type','name','description','options','default_member_permissions','nsfw'];
process.stdout.write(JSON.stringify(result.map(item=>Object.fromEntries(fields.filter(k=>item[k]!==undefined).map(k=>[k,item[k]])))));
"""
RESTORE_COMMANDS = """
import fs from 'node:fs';import {REST,Routes} from 'discord.js';import {loadConfig} from './src/config/load-config.js';
const {config}=loadConfig();const rest=new REST({version:'10'}).setToken(process.env.DISCORD_BOT_TOKEN);
const body=JSON.parse(fs.readFileSync(0,'utf8'));
await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID,config.discord.guildId),{body});
"""


def log(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def run(*args, cwd=None, data=None, timeout=600):
    # Capture subprocess output: provider failures must not print runtime config or secrets.
    result = subprocess.run(args, cwd=cwd, input=data, text=True, capture_output=True,
                            timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed with exit {result.returncode}")
    return result.stdout


def save_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def validate_config(config):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", config["repository"]):
        raise ValueError("Invalid repository")
    paths = {key: Path(config[key]).expanduser().resolve()
             for key in ("app_root", "state_root", "release_root")}
    app = paths["app_root"]
    if not (app / "compose.yaml").is_file():
        raise ValueError("Application compose.yaml not found")
    for key in ("state_root", "release_root"):
        target = paths[key]
        if target in (Path("/"), Path.home()) or target.is_relative_to(app) or app.is_relative_to(target):
            raise ValueError("Unsafe deployment directory")
    if paths["state_root"] == paths["release_root"]:
        raise ValueError("Deployment directories must differ")
    for name in APP_DIRS:
        if (app / name).is_symlink():
            raise ValueError("Application source directories must not be symlinks")
    return paths


def successful_main_run(payload, sha):
    matches = [item for item in payload.get("workflow_runs", [])
               if item.get("head_sha") == sha and item.get("head_branch") == "main"
               and item.get("event") == "push" and item.get("path") == ".github/workflows/ci.yml"]
    if not matches:
        return False
    latest = max(matches, key=lambda item: (item.get("id", 0), item.get("run_attempt", 0)))
    return latest.get("status") == "completed" and latest.get("conclusion") == "success"


def check_ci(repository, sha):
    query = urllib.parse.urlencode({"branch": "main", "event": "push", "head_sha": sha, "per_page": 10})
    url = f"https://api.github.com/repos/{repository}/actions/workflows/ci.yml/runs?{query}"
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "discord-ai-chat-deploy",
        "X-GitHub-Api-Version": "2026-03-10",
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return successful_main_run(json.load(response), sha)
    except urllib.error.HTTPError as error:
        error.close()
        if error.code in (403, 429):
            raise RuntimeError("GitHub API temporarily unavailable") from None
        if error.code == 404:
            return False
        raise RuntimeError(f"GitHub API HTTP {error.code}") from None


def extract_source(archive, destination):
    destination = Path(destination).resolve()
    with tarfile.open(archive) as package:
        for member in package.getmembers():
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination) or not (member.isfile() or member.isdir()):
                raise ValueError("Unsafe source archive member")
        package.extractall(destination, filter="data")


def backup_database(source, destination):
    with closing(sqlite3.connect(Path(source).as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(destination)) as backup:
            original.backup(backup)
            if backup.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("Database backup check failed")
    Path(destination).chmod(0o600)


def restore_modes(database, backup):
    # Restore only channel settings; keep any new conversation recorded during the cutover.
    with closing(sqlite3.connect(Path(backup).as_uri() + "?mode=ro", uri=True)) as previous:
        rows = previous.execute("SELECT guild_id,channel_id,configured_mode,mode_override,previous_mode FROM channels").fetchall()
    with closing(sqlite3.connect(database)) as current:
        with current:
            for guild, channel, configured, override, old in rows:
                current.execute("""UPDATE channels SET configured_mode=?,mode_override=?,previous_mode=?,
                    version=version+1,context_revision=context_revision+1 WHERE guild_id=? AND channel_id=?""",
                    (configured, override, old, guild, channel))


def remove_verification_database(directory):
    for name in ("bot.sqlite3", "bot.sqlite3-wal", "bot.sqlite3-shm"):
        (directory / name).unlink(missing_ok=True)


def source_hashes(directory):
    paths = [path for name in APP_DIRS for path in (directory / name).rglob("*") if path.is_file()]
    paths += [directory / name for name in APP_FILES]
    return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            for path in paths}


class Deployment:
    def __init__(self, config):
        self.config = config
        self.paths = validate_config(config)
        self.app = self.paths["app_root"]
        self.state_root = self.paths["state_root"]
        self.releases = self.paths["release_root"]
        for path in (self.state_root, self.releases):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_path = self.state_root / "state.json"
        self.pending_path = self.state_root / "pending.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.mirror = self.state_root / "repository.git"

    def compose(self, *args, data=None):
        return run("docker", "compose", *args, cwd=self.app, data=data)

    def latest_main(self):
        repository = self.config["repository"]
        remote = f"https://github.com/{repository}.git"
        if not self.mirror.exists():
            run("git", "init", "--bare", str(self.mirror))
            run("git", "--git-dir", str(self.mirror), "remote", "add", "origin", remote)
        run("git", "-c", "credential.helper=", "--git-dir", str(self.mirror), "fetch", "--no-tags",
            "origin", "+refs/heads/main:refs/heads/main")
        sha = run("git", "--git-dir", str(self.mirror), "rev-parse", "refs/heads/main").strip()
        if not SHA_PATTERN.fullmatch(sha):
            raise ValueError("Invalid main revision")
        return sha

    def save_state(self, **fields):
        self.state.update(fields)
        save_json(self.state_path, self.state)

    def wait_ready(self, expected_image):
        for _ in range(30):
            state = json.loads(run("docker", "inspect", "discord-ai-chat"))[0]
            events = []
            for line in run("docker", "logs", "discord-ai-chat").splitlines():
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
            if any(item.get("event") == "service_fatal" for item in events):
                raise RuntimeError("Bot startup failed")
            if (state["State"]["Running"] and state["Image"] == expected_image
                    and any(item.get("event") == "discord_ready" for item in events)):
                return
            time.sleep(1)
        raise RuntimeError("Discord readiness timeout")

    def container_checks(self, image, source, verification):
        run("docker", "run", "--rm", "--network", "none", "--mount",
            f"type=bind,source={source / 'test'},target=/app/test,readonly", image,
            "node", "--test", "test/*.test.js")
        try:
            backup_database(self.app / "data/bot.sqlite3", verification / "bot.sqlite3")
            run("docker", "run", "--rm", "--network", "host", "--env-file", str(self.app / "runtime/bot.env"),
                "--env", "BOT_CONFIG=/app/runtime/bot.yaml", "--env", "BOT_DATABASE_PATH=/app/data/bot.sqlite3",
                "--mount", f"type=bind,source={self.app / 'runtime/bot.yaml'},target=/app/runtime/bot.yaml,readonly",
                "--mount", f"type=bind,source={verification},target=/app/data", image,
                "node", "scripts/doctor.js")
        finally:
            remove_verification_database(verification)

    def rollback(self, transaction):
        release = Path(transaction["release"]).resolve()
        if release.parent != self.releases or not re.fullmatch(r"[0-9a-f]{12}-\d+", release.name):
            raise ValueError("Unsafe recovery directory")
        try:
            run("docker", "stop", "--time", "40", "discord-ai-chat")
        except RuntimeError:
            pass
        for name in APP_DIRS:
            previous = release / f"previous-{name}"
            if previous.exists():
                active = self.app / name
                if active.exists():
                    active.rename(release / f"failed-{name}-{time.time_ns()}")
                previous.rename(active)
        for name in APP_FILES:
            shutil.copy2(release / "previous-files" / name, self.app / name)
        backup = Path(transaction["backup"])
        if backup.exists():
            restore_modes(self.app / "data/bot.sqlite3", backup)
        run("docker", "image", "tag", transaction["rollback_image"], "discord-ai-chat-bot:latest")
        self.compose("up", "-d", "--no-build", "--no-deps", "bot")
        self.wait_ready(transaction["previous_image"])
        if transaction["registry_changed"]:
            commands = (release / "previous-commands.json").read_text()
            self.compose("exec", "-T", "bot", "node", "--input-type=module", "-e", RESTORE_COMMANDS, data=commands)
        self.state = transaction["previous_state"]
        save_json(self.state_path, self.state)
        self.pending_path.unlink(missing_ok=True)
        log("deployment_rolled_back", sha=transaction["sha"])

    def recover(self):
        if not self.pending_path.exists():
            return
        transaction = json.loads(self.pending_path.read_text())
        if self.state.get("deployed_sha") == transaction["sha"]:
            self.pending_path.unlink()
            return
        self.rollback(transaction)

    def prune_backups(self):
        # Only the controller's own database snapshots; existing manual backups are untouched.
        for path in (self.app / "data/backups").glob("bot-*-autodeploy.sqlite3"):
            if (re.fullmatch(r"bot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-autodeploy.sqlite3", path.name)
                    and not path.is_symlink() and time.time() - path.stat().st_mtime > 7 * 86400):
                path.unlink()

    def deploy(self, sha):
        if self.latest_main() != sha:
            log("deployment_superseded", sha=sha)
            return
        release = self.releases / f"{sha[:12]}-{time.time_ns()}"
        release.mkdir(mode=0o700)
        archive = release / "source.tar"
        run("git", "--git-dir", str(self.mirror), "archive", "--format=tar", f"--output={archive}", sha)
        source = release / "source"
        source.mkdir()
        extract_source(archive, source)
        image = f"discord-ai-chat:auto-{sha}"
        run("docker", "build", "--label", f"org.opencontainers.image.revision={sha}", "--tag", image, str(source))
        verification = release / "verification"
        verification.mkdir(mode=0o700)
        self.container_checks(image, source, verification)
        if self.latest_main() != sha:
            log("deployment_superseded", sha=sha)
            return
        previous_image = json.loads(run("docker", "inspect", "discord-ai-chat"))[0]["Image"]
        rollback_image = f"discord-ai-chat:rollback-{sha[:12]}"
        run("docker", "image", "tag", previous_image, rollback_image)
        commands = self.compose("exec", "-T", "bot", "node", "--input-type=module", "-e", BACKUP_COMMANDS)
        # Validate backup before touching the running bot.
        if not isinstance(json.loads(commands), list):
            raise RuntimeError("Invalid Discord command backup")
        (release / "previous-commands.json").write_text(commands)
        old_files = release / "previous-files"
        old_files.mkdir()
        for name in APP_DIRS:
            shutil.copytree(source / name, release / f"pending-{name}")
        for name in APP_FILES:
            target = old_files / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.app / name, target)
        database = self.app / "data/bot.sqlite3"
        stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime())
        backup = self.app / f"data/backups/bot-{stamp}-autodeploy.sqlite3"
        backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        transaction = {"sha": sha, "release": str(release), "previous_image": previous_image,
                       "rollback_image": rollback_image, "backup": str(backup),
                       "registry_changed": False, "previous_state": dict(self.state)}
        save_json(self.pending_path, transaction)
        try:
            self.compose("stop", "-t", "40", "bot")
            backup_database(database, backup)
            for name in APP_DIRS:
                pending = release / f"pending-{name}"
                (self.app / name).rename(release / f"previous-{name}")
                pending.rename(self.app / name)
            for name in APP_FILES:
                shutil.copy2(source / name, self.app / name)
            run("docker", "image", "tag", image, "discord-ai-chat-bot:latest")
            self.compose("up", "-d", "--no-build", "--no-deps", "bot")
            expected = json.loads(run("docker", "image", "inspect", image))[0]["Id"]
            self.wait_ready(expected)
            self.compose("exec", "-T", "bot", "node", "scripts/doctor.js")
            transaction["registry_changed"] = True
            save_json(self.pending_path, transaction)
            self.compose("exec", "-T", "bot", "node", "scripts/register-commands.js")
            self.compose("exec", "-T", "bot", "node", "scripts/register-commands.js", "--check")
            if source_hashes(source) != source_hashes(self.app):
                raise RuntimeError("Deployed source does not match main")
        except Exception:
            self.rollback(transaction)
            raise
        save_json(release / "receipt.json", {"sha": sha, "image": image, "verified": True})
        self.save_state(deployed_sha=sha, deployed_image=image, deployed_at=int(time.time()),
                        failed_sha=None, pending_sha=None, next_ci_check=0)
        self.pending_path.unlink(missing_ok=True)
        log("deployment_completed", sha=sha, image=image)

    def once(self):
        sha = self.latest_main()
        if sha == self.state.get("deployed_sha") or sha == self.state.get("failed_sha"):
            return
        if sha == self.state.get("pending_sha") and time.time() < self.state.get("next_ci_check", 0):
            return
        try:
            passed = check_ci(self.config["repository"], sha)
        except Exception:
            self.save_state(pending_sha=sha, next_ci_check=int(time.time()) + 900)
            raise
        if not passed:
            self.save_state(pending_sha=sha, next_ci_check=int(time.time()) + 60)
            log("deployment_waiting_for_ci", sha=sha)
            return
        try:
            self.deploy(sha)
        except Exception:
            self.save_state(failed_sha=sha)
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--retry", action="store_true")
    options = parser.parse_args()
    config = json.loads(Path(options.config).read_text())
    deployment = Deployment(config)
    if options.status:
        print(json.dumps(deployment.state, indent=2))
        return
    with (deployment.state_root / "lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        # Load again under the lock; a previous deployment may have just completed.
        deployment.state = json.loads(deployment.state_path.read_text()) if deployment.state_path.exists() else {}
        deployment.recover()
        deployment.prune_backups()
        if options.retry:
            deployment.save_state(failed_sha=None, next_ci_check=0)
        deployment.once()


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise RuntimeError("Deployment interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except Exception as error:
        log("deployment_failed", reason=str(error))
        raise SystemExit(1) from None
