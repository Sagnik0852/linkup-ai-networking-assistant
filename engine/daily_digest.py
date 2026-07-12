"""
daily_digest.py - LinkUp follow-up engine.
Runs every morning on GitHub Actions. Steps:
  1. Read all active contacts from Supabase
  2. Apply simple rules: who is due a follow-up, and why?
  3. Ask Claude to draft a short message for each (max 10/day)
  4. Record drafts in the follow_ups table (so we never nag twice)
  5. Email you one digest, ready to copy-paste
"""

import os
import smtplib
import datetime as dt
from email.mime.text import MIMEText

import requests  # the one external library we need

# ---------- Config: all secrets come from environment variables ----------
# (set as GitHub Actions secrets - never written in this file)
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
GMAIL_ADDRESS = os.environ["GMAIL_ADDRESS"]          # digest goes from+to this
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]

TODAY = dt.date.today()
MAX_ITEMS = 10  # attention budget: never more than 10 follow-ups per morning

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


# ---------- Tiny Supabase helpers ----------
def sb_get(table, params):
    """Read rows from a table."""
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SB_HEADERS, params=params)
    r.raise_for_status()
    return r.json()


def sb_post(table, rows):
    """Insert rows into a table."""
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=SB_HEADERS, json=rows)
    r.raise_for_status()


def days_since(iso_date):
    """How many days ago was this YYYY-MM-DD date? None if missing."""
    if not iso_date:
        return None
    return (TODAY - dt.date.fromisoformat(iso_date)).days


# ---------- Step 2: the rules ----------
def find_due(contacts, already_pending_ids):
    """Return a list of (contact, reason) pairs that deserve a follow-up today."""
    due = []
    for c in contacts:
        if c["id"] in already_pending_ids:
            continue  # robot already drafted for them; don't nag twice

        d = days_since(c.get("last_contacted"))
        nfu = c.get("next_follow_up")
        reason = None

        # Rule 1: a follow-up date was scheduled and it has arrived
        if nfu and dt.date.fromisoformat(nfu) <= TODAY:
            reason = "Scheduled follow-up date reached"
        # Rule 2: you sent the first message, no conversation logged in 5+ days
        elif c.get("status") == "messaged" and d is not None and d >= 5:
            reason = f"You messaged them {d} days ago - no reply logged"
        # Rule 3: high referral potential going quiet
        elif (c.get("referral_potential") or 0) >= 4 and d is not None and d >= 7:
            reason = f"High referral potential, quiet for {d} days"
        # Rule 4: good relationship going cold
        elif (c.get("relationship_strength") or 0) >= 3 and d is not None and d >= 30:
            reason = f"Good relationship going cold ({d} days silent)"

        if reason:
            due.append((c, reason))

    return due[:MAX_ITEMS]


# ---------- Step 3: ask Claude for a draft ----------
def draft_message(c, reason):
    prompt = f"""Draft a short LinkedIn follow-up from Sagnik (BITS Pilani student,
job-searching) to {c['full_name']} ({c.get('role') or ''} at {c.get('company') or ''}).

WHY NOW: {reason}
RELATIONSHIP CONTEXT: {c.get('conversation_summary') or 'Only the first message was sent so far.'}
LAST CONTACTED: {c.get('last_contacted') or 'unknown'}

RULES: under 250 characters, reference something concrete from the context,
do not guilt-trip them, do not repeat the previous message, give them an
easy out. Return ONLY the message text, nothing else."""

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-sonnet-5",
            "max_tokens": 400,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    r.raise_for_status()
    return r.json()["content"][0]["text"].strip()


# ---------- Step 5: email the digest ----------
def send_email(subject, html):
    msg = MIMEText(html, "html")
    msg["Subject"] = subject
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = GMAIL_ADDRESS
    # Port 465 = Gmail's secure SMTP. The app password authorizes this script only.
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        server.send_message(msg)


# ---------- Main ----------
def main():
    # 1. Active contacts only (closed/dormant people are left alone)
    contacts = sb_get("contacts", {"select": "*", "status": "not.in.(closed,dormant)"})

    # People who already have an undealt-with draft from a previous morning
    pending = sb_get("follow_ups", {"select": "contact_id", "status": "eq.pending"})
    pending_ids = {p["contact_id"] for p in pending}

    due = find_due(contacts, pending_ids)
    print(f"{len(contacts)} active contacts, {len(due)} due for follow-up.")

    if not due:
        send_email(
            f"LinkUp {TODAY}: all clear",
            "<p>No follow-ups due today. Go capture some new connections! 🚀</p>",
        )
        return

    # 3+4. Draft each one and record it
    blocks = []
    for c, reason in due:
        text = draft_message(c, reason)
        sb_post("follow_ups", [{
            "contact_id": c["id"], "due_date": str(TODAY),
            "reason": reason, "draft": text, "status": "pending",
        }])
        blocks.append(f"""
          <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0">
            <b>{c['full_name']}</b> — {c.get('role') or ''} @ {c.get('company') or ''}<br>
            <span style="color:#a55">Why: {reason}</span>
            <p style="background:#f6f8fa;padding:10px;border-radius:6px">{text}</p>
            <a href="{c['linkedin_url']}">Open their LinkedIn →</a>
          </div>""")

    send_email(
        f"LinkUp {TODAY}: {len(due)} follow-up(s) ready",
        f"<h2>☀️ Your networking follow-ups for today</h2>{''.join(blocks)}"
        "<p style='color:#888'>Copy, tweak, send — then LinkUp captures the replies.</p>",
    )
    print("Digest sent.")


if __name__ == "__main__":
    main()