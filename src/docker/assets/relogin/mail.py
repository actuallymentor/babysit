#!/usr/bin/env python3
"""
Find the Claude login email in Gmail and print its link (or code) as JSON.

    mail.py --since EPOCH [--timeout 600]     poll Gmail over IMAP
    mail.py --since EPOCH --check FILE.eml    judge one saved message (tests)

Only messages from allowlisted senders, newer than the login start, are ever
fetched; other mail in the box is never read. A message counts only when
Gmail's own Authentication-Results stamp (the topmost one from mx.google.com)
shows DKIM passing for the From domain. Forwarding inside Google keeps the
sender's signature intact, so forwarded mail passes the same test.

Exit codes: 0 found, 2 Gmail rejected the login, 3 timed out, 4 bad input.
"""

import argparse
import email
import email.policy
import email.utils
import html
import imaplib
import json
import os
import re
import sys
import time
from urllib.parse import urlparse

IMAP_HOST = "imap.gmail.com"
AUTHSERV_ID = "mx.google.com"
SENDERS = ["anthropic.com", "claude.ai", "claude.com"]
LINK_HOSTS = ["claude.ai", "claude.com", "anthropic.com"]
POLL_S = 5
CLOCK_SKEW_S = 60


def in_domains(host, domains):
    host = (host or "").lower().rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def org_domain(host):
    # Good enough for the allowlisted senders, which are all two-label roots
    return ".".join((host or "").lower().rstrip(".").split(".")[-2:])


def gmail_stamp(message):
    """Gmail's own verdict: the topmost Authentication-Results it wrote.
    Lower copies may come from forwarders or from the sender itself."""
    for header in message.get_all("Authentication-Results") or []:
        authserv = str(header).split(";", 1)[0].strip().split()[0:1]
        if authserv and authserv[0].lower() == AUTHSERV_ID:
            return str(header)
    return None


def dkim_signer(result):
    """The signing domain of one dkim= result: header.d, else the domain of
    header.i. The identity's local part may itself contain '@' (RFC 6376
    3.5), so only the text after the last '@' is a domain."""
    domain = re.search(r"header\.d=([\w.-]+)", result, re.I)
    if domain:
        return domain.group(1)
    identity = re.search(r"header\.i=(\S+)", result, re.I)
    return identity.group(1).rpartition("@")[2].rstrip(";") if identity else None


def dkim_aligned(stamp, from_domain):
    for match in re.finditer(r"dkim=pass\b([^;]*)", stamp or "", re.I):
        signer = dkim_signer(match.group(1))
        if signer and org_domain(signer) == org_domain(from_domain):
            return True
    return False


def body_text(message):
    parts = []
    for part in message.walk():
        if part.get_content_type() in ("text/plain", "text/html"):
            try:
                parts.append(part.get_content())
            except Exception:
                continue
    return html.unescape("\n".join(parts))


def find_link(text):
    links = [url.rstrip(".,;)") for url in re.findall(r"https://[^\s\"'<>]+", text)]
    allowed = [url for url in links if in_domains(urlparse(url).hostname, LINK_HOSTS)]
    for hint in ("magic", "login", "verify", "auth"):
        for url in allowed:
            if hint in url.lower():
                return url
    return None


def find_code(text):
    plain = re.sub(r"<[^>]+>", " ", text)
    if not re.search(r"\bcode\b", plain, re.I):
        return None
    match = re.search(r"(?<![\w-])(\d{6})(?![\w-])", plain)
    return match.group(1) if match else None


def judge(raw, since, senders=SENDERS):
    """Return {link} or {code} for a trustworthy login email, else {reason}."""
    message = email.message_from_bytes(raw, policy=email.policy.default)

    from_domain = email.utils.parseaddr(str(message.get("From", "")))[1].rpartition("@")[2].lower()
    if not in_domains(from_domain, senders):
        return {"reason": f"sender {from_domain or 'unknown'} is not allowlisted"}

    if not dkim_aligned(gmail_stamp(message), from_domain):
        return {"reason": "Gmail did not verify the sender's DKIM signature"}

    try:
        sent = email.utils.parsedate_to_datetime(str(message.get("Date"))).timestamp()
    except Exception:
        return {"reason": "message has no readable Date"}
    if sent < since - CLOCK_SKEW_S:
        return {"reason": "message predates this login"}

    text = body_text(message)
    link = find_link(text)
    if link:
        return {"link": link}
    code = find_code(text)
    if code:
        return {"code": code}
    return {"reason": "no login link or code in the message"}


def search_query(since, senders):
    day = time.strftime("%d-%b-%Y", time.gmtime(since - 86_400))
    query = f'FROM "{senders[0]}"'
    for sender in senders[1:]:
        query = f'OR {query} FROM "{sender}"'
    # Unread only: an accepted message is marked read and never reused
    return f"(UNSEEN SINCE {day} {query})"


def poll(since, timeout_s, senders):
    user = os.environ.get("GMAIL_USER", "").strip()
    password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not user or not password:
        return 4, {"error": "config", "reason": "set GMAIL_USER and GMAIL_APP_PASSWORD in ~/.babysitrc"}

    imap = imaplib.IMAP4_SSL(IMAP_HOST, 993, timeout=30)
    try:
        try:
            imap.login(user, password)
        except imaplib.IMAP4.error:
            return 2, {"error": "auth", "reason": "Gmail rejected GMAIL_USER / GMAIL_APP_PASSWORD"}

        imap.select("INBOX")
        seen = set()
        last_reason = None
        deadline = time.time() + timeout_s

        while time.time() < deadline:
            imap.noop()
            _, found = imap.search(None, search_query(since, senders))
            for number in (found[0] or b"").split():
                if number in seen:
                    continue
                seen.add(number)
                _, data = imap.fetch(number, "(BODY.PEEK[])")
                raw = next((item[1] for item in data if isinstance(item, tuple)), b"")
                verdict = judge(raw, since, senders)
                if "reason" in verdict:
                    last_reason = verdict["reason"]
                    continue
                # Mark it read so a later run never reuses it
                imap.store(number, "+FLAGS", "\\Seen")
                return 0, verdict
            time.sleep(POLL_S)

        reason = "no login email from Anthropic arrived in Gmail"
        if last_reason:
            reason += f" (last rejected: {last_reason})"
        return 3, {"error": "timeout", "reason": reason}
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", type=float, required=True)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--check")
    args = parser.parse_args()

    override = os.environ.get("BABYSIT_RELOGIN_SENDERS", "")
    senders = [s.strip().lower() for s in override.split(",") if s.strip()] or SENDERS

    if args.check:
        with open(args.check, "rb") as handle:
            verdict = judge(handle.read(), args.since, senders)
        print(json.dumps(verdict))
        return 0 if "reason" not in verdict else 1

    try:
        code, result = poll(args.since, args.timeout, senders)
    except (OSError, imaplib.IMAP4.error) as error:
        code, result = 3, {"error": "imap", "reason": f"Gmail IMAP failed: {error}"}
    print(json.dumps(result))
    return code


if __name__ == "__main__":
    sys.exit(main())
