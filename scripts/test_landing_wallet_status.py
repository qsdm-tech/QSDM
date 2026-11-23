#!/usr/bin/env python3
"""The web wallet's status lines are plain text.

Status messages in QSDM/deploy/landing/wallet.js and
QSDM/deploy/landing/assets/wallet-ui/vault.js carry keystore fields, API
replies and the user's own input. The status helpers must set them as text
(textContent), never as HTML (innerHTML), and the busy spinner is added by
setStatusBusy, not by passing markup in a message.

Run: python -m unittest scripts.test_landing_wallet_status
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LANDING = REPO_ROOT / "QSDM" / "deploy" / "landing"
WALLET_FILES = (LANDING / "wallet.js", LANDING / "assets" / "wallet-ui" / "vault.js")
HELPERS = ("setStatus", "setStatusBusy")

# One fake element per id: records what the helpers do, and fails on innerHTML.
NODE_HARNESS = r"""
const elements = {};
function makeElement(tag) {
  const el = {
    tag, className: '', nodes: [],
    set textContent(value) { this.nodes = value === '' || value == null ? [] : [{ text: String(value) }]; },
    get textContent() { return this.nodes.map((n) => (n.text !== undefined ? n.text : n.textContent)).join(''); },
    appendChild(child) { this.nodes.push(child); return child; },
    set innerHTML(value) { throw new Error('innerHTML used: ' + value); },
  };
  return el;
}
const document = {
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ text: String(text) }),
};
const $ = (id) => elements[id] || (elements[id] = makeElement('div'));
%HELPERS%
const markup = '<img src=x onerror="alert(1)"><b>bold</b>';
setStatus('plain', markup);
setStatus('styled', markup, 'err');
setStatusBusy('busy', markup);
setStatus('cleared', 'first', 'ok');
setStatus('cleared', '', null);
const describe = (el) => el.nodes.map((n) => (n.tag ? { tag: n.tag, className: n.className, text: n.textContent } : { text: n.text }));
console.log(JSON.stringify({
  plain: describe(elements.plain),
  styled: describe(elements.styled),
  busy: describe(elements.busy),
  cleared: describe(elements.cleared),
  markup,
}));
"""


def helper_source(text: str, name: str) -> str:
    """Returns the source of `function name(...) { ... }` (two-space indent)."""
    match = re.search(r"^  function " + re.escape(name) + r"\(.*?^  \}$", text, re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError(f"function {name} not found")
    return match.group(0)


class LandingWalletStatusTest(unittest.TestCase):
    def test_helpers_set_text_not_html(self) -> None:
        for path in WALLET_FILES:
            text = path.read_text(encoding="utf-8")
            for name in HELPERS:
                with self.subTest(file=path.name, helper=name):
                    source = helper_source(text, name)
                    self.assertNotIn("innerHTML", source)
                    self.assertIn("textContent", source)

    def test_no_markup_in_status_messages(self) -> None:
        call = re.compile(r"\bsetStatus(?:Busy)?\(\s*'[^']*'\s*,\s*['\"`]<")
        for path in WALLET_FILES:
            text = path.read_text(encoding="utf-8")
            with self.subTest(file=path.name):
                self.assertEqual(call.findall(text), [])

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_helpers_render_markup_as_text(self) -> None:
        for path in WALLET_FILES:
            text = path.read_text(encoding="utf-8")
            helpers = "\n".join(helper_source(text, name) for name in HELPERS)
            script = NODE_HARNESS.replace("%HELPERS%", helpers)
            with self.subTest(file=path.name):
                out = subprocess.run(
                    ["node", "-e", script], capture_output=True, text=True, check=True, timeout=60
                ).stdout
                result = json.loads(out)
                markup = result["markup"]
                self.assertEqual(result["plain"], [{"text": markup}])
                self.assertEqual(result["styled"], [{"tag": "span", "className": "err", "text": markup}])
                self.assertEqual(
                    result["busy"], [{"tag": "span", "className": "spinner", "text": ""}, {"text": markup}]
                )
                self.assertEqual(result["cleared"], [])


if __name__ == "__main__":
    unittest.main()
