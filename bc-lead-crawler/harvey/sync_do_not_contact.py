"""Refresh Harvey's do-not-contact list from the lead crawler.

Every company the crawler has a website for (buyers it emails itself, competitors,
companies under review) and every domain in data/blocklist.txt goes into
compliance.do_not_contact, so Harvey never emails a company the crawler handles.

Usage:
    python3 bc-lead-crawler/harvey/sync_do_not_contact.py            # updates both segment files here
    python3 bc-lead-crawler/harvey/sync_do_not_contact.py PATH.yaml  # also/only update PATH.yaml
                                                                     # (e.g. your Harvey folder's harvey.local.yaml)
"""

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
CRAWLER = HERE.parent
ALWAYS = ["bestconstruction.pro"]
DOMAIN_RE = re.compile(r"^(?:[a-z0-9-]+\.)+[a-z]{2,}$")


def domain_of(value: str) -> str:
    value = value.strip().lower()
    if not value:
        return ""
    host = urlparse(value if "//" in value else f"//{value}").hostname or ""
    host = host.removeprefix("www.")
    return host if DOMAIN_RE.match(host) else ""


def crawler_domains() -> list[str]:
    found = list(ALWAYS)
    registry = json.loads((CRAWLER / "buyer-registry.json").read_text())
    for company in registry.get("companies", []):
        found.append(domain_of(company.get("website") or ""))
    blocklist = CRAWLER / "data" / "blocklist.txt"
    if blocklist.exists():
        for line in blocklist.read_text().splitlines():
            if not line.strip().startswith("#"):
                found.append(domain_of(line))
    seen: list[str] = []
    for d in found:
        if d and d not in seen:
            seen.append(d)
    return seen


def rewrite(path: Path, domains: list[str]) -> None:
    text = path.read_text()
    match = re.search(r"^(  do_not_contact:)[^\n]*\n(?:    .*\n|\s*#.*\n)*", text, re.M)
    if not match:
        sys.exit(f"{path}: no compliance.do_not_contact block found")
    block = match.group(1) + "\n" + "".join(f'    - "{d}"\n' for d in domains)
    path.write_text(text[: match.start()] + block + text[match.end():])
    print(f"{path}: {len(domains)} entries")


def main() -> None:
    targets = [Path(p) for p in sys.argv[1:]] or sorted(HERE.glob("*/harvey.local.yaml"))
    domains = crawler_domains()
    for target in targets:
        rewrite(target, domains)


if __name__ == "__main__":
    main()
