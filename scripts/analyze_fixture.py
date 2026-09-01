#!/usr/bin/env python3
"""
T18/PRD §8 — fixture analysis.

    python3 scripts/analyze_fixture.py exported.json [more.json ...]

Reads the JSON exported by the fixture runner and answers the only question the
POC exists to answer: do Set A and Set B separate?

    separation = percentile(Set A, 25) - percentile(Set B, 75)

Positive means the scorer distinguishes accented-but-correct speech from
fluent-but-incorrect speech. Negative means it does not, and nothing downstream
is worth building.

The 25th/75th choice is deliberate: comparing means would let a few confident
outliers manufacture a gap that the typical learner never sees.

Restored from git history (commit c52fcb3, removed in 5764ef8) and extended
with a per-language breakdown — this was written back when the app only
covered one locale; it now covers four (src/activities/languages/), and PRD
§8's separation question needs answering per language, not just per platform.

Plotting needs matplotlib. Without it the tables still print — the numbers are
the deliverable, the chart is a convenience.
"""

import json
import sys
import re
from collections import defaultdict


def percentile(values, p):
    """Linear-interpolated percentile. No numpy dependency."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * p
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    frac = pos - lo
    return ordered[lo] * (1 - frac) + ordered[hi] * frac


def platform_of(user_agent):
    """Coarse bucket. We only need to tell iPhone from desktop (OQ-3)."""
    ua = user_agent or ""
    if re.search(r"iPhone", ua):
        return "iPhone Safari" if "CriOS" not in ua and "FxiOS" not in ua else "iPhone other"
    if re.search(r"iPad", ua):
        return "iPad Safari"
    if re.search(r"Android", ua):
        return "Android Chrome"
    if re.search(r"Macintosh", ua):
        return "macOS Safari" if "Chrome" not in ua else "macOS Chrome"
    if re.search(r"Windows", ua):
        return "Windows Chrome"
    return "other"


def load(paths):
    entries = []
    for path in paths:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, list):
            sys.exit(f"{path}: expected a JSON array from the fixture runner")
        entries.extend(data)
    return entries


def print_distribution_table(by_set):
    header = f"{'set':<10}{'n':>4}{'p25':>8}{'median':>8}{'p75':>8}"
    print(header)
    print("-" * len(header))
    for set_id in sorted(by_set):
        values = by_set[set_id]
        print(
            f"{set_id:<10}{len(values):>4}"
            f"{percentile(values, 0.25):>8.1f}"
            f"{percentile(values, 0.50):>8.1f}"
            f"{percentile(values, 0.75):>8.1f}"
        )


def separation_of(by_set):
    """None if either set is empty — a real result requires both."""
    a = by_set.get("A", [])
    b = by_set.get("B", [])
    if not a or not b:
        return None
    return percentile(a, 0.25) - percentile(b, 0.75)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip())

    entries = load(sys.argv[1:])
    if not entries:
        sys.exit("no attempts found")

    scored = []
    indeterminate = 0

    for e in entries:
        result = e.get("result") or {}
        if result.get("indeterminate"):
            indeterminate += 1
            continue
        overall = result.get("overall")
        accuracy = result.get("accuracy")
        if overall is None or accuracy is None:
            indeterminate += 1
            continue
        scored.append(
            {
                "set": e.get("set", "?"),
                "speaker": e.get("speaker") or "—",
                "language": e.get("language") or "?",
                "platform": platform_of(e.get("ua")),
                "overall": overall,
                "accuracy": accuracy,
            }
        )

    total = len(entries)
    print(f"attempts        {total}")
    print(f"scored          {len(scored)}")
    print(f"indeterminate   {indeterminate}"
          f"{'  <- these are excluded, not counted as zero' if indeterminate else ''}")
    print()

    if not scored:
        sys.exit("nothing scorable to analyse")

    languages = sorted({row["language"] for row in scored})

    # ── per language ─────────────────────────────────────────────────────────
    for language in languages:
        rows = [r for r in scored if r["language"] == language]
        print(f"═══ {language} ({len(rows)} scored) ═══")

        by_set = defaultdict(list)
        for row in rows:
            by_set[row["set"]].append(row["accuracy"])
        print_distribution_table(by_set)

        overall_sep = separation_of(by_set)
        if overall_sep is not None:
            verdict = "separates" if overall_sep > 0 else "DOES NOT separate"
            print(f"  separation (A p25 − B p75): {overall_sep:.1f}   {verdict}")
        else:
            print("  needs both Set A and Set B recordings for this language")

        # Per-platform breakdown within this language — PRD §8's other axis
        # (OQ-3: do iOS-captured recordings score differently from desktop).
        by_platform = defaultdict(lambda: defaultdict(list))
        for row in rows:
            by_platform[row["platform"]][row["set"]].append(row["accuracy"])
        if len(by_platform) > 1:
            print("  by platform:")
            for platform in sorted(by_platform):
                sep = separation_of(by_platform[platform])
                if sep is None:
                    print(f"    {platform:<18} needs both sets on this platform")
                else:
                    verdict = "separates" if sep > 0 else "DOES NOT separate"
                    print(f"    {platform:<18} separation {sep:>6.1f}   {verdict}")
        print()

    # ── overall, across every language ──────────────────────────────────────
    all_by_set = defaultdict(list)
    for row in scored:
        all_by_set[row["set"]].append(row["accuracy"])
    overall_sep = separation_of(all_by_set)
    if overall_sep is not None:
        print("═══ ALL LANGUAGES ═══")
        print_distribution_table(all_by_set)
        verdict = "separates" if overall_sep > 0 else "DOES NOT separate"
        print(f"  separation (A p25 − B p75): {overall_sep:.1f}   {verdict}")
        print()
        if overall_sep <= 0:
            print("Set A's 25th percentile does not clear Set B's 75th. On this evidence the")
            print("scorer is not measuring pronunciation — stop and investigate before building")
            print("anything on top of it (TASKS.md T19, outcome 4).")

    plot(scored)


def plot(scored):
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print()
        print("(matplotlib not installed — tables only. `pip install matplotlib` for the plot.)")
        return

    languages = sorted({row["language"] for row in scored})
    fig, axes = plt.subplots(1, len(languages), figsize=(4 * len(languages), 4.5), squeeze=False)

    for ax, language in zip(axes[0], languages):
        by_set = defaultdict(list)
        for row in scored:
            if row["language"] == language:
                by_set[row["set"]].append(row["accuracy"])
        sets = sorted(by_set)
        data = [by_set[s] for s in sets]
        ax.boxplot(data, labels=sets)
        ax.set_title(language, fontsize=10)
        ax.set_ylim(0, 100)
        ax.set_ylabel("accuracy")
        ax.grid(axis="y", alpha=0.3)

    fig.suptitle("Set A (accented, correct) vs Set B (deliberately wrong), per language")
    fig.tight_layout()
    out = "fixture-separation.png"
    fig.savefig(out, dpi=140)
    print()
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
