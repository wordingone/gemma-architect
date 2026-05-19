"""Shared port constants. Override via env vars for CI or non-standard setups."""
import os

CDP_PORT: int = int(os.environ.get("CDP_PORT", "9222"))
DEV_PORT: int = int(os.environ.get("DEV_PORT", "5175"))
CDP_BASE: str = f"http://localhost:{CDP_PORT}"
DEV_BASE: str = f"http://localhost:{DEV_PORT}"
DEV_URL:  str = f"http://localhost:{DEV_PORT}/"
