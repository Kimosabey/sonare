// @vitest-environment jsdom

/**
 * The syllabus, which existed as data for days and appeared nowhere.
 *
 * `cefr.test.ts` proves the map is complete and internally consistent.
 * Nothing proved it reached a screen, because nothing did — the answer to
 * "what does this course cover" was reading the source. That is the fourth
 * time in this repository a join has been the missing piece rather than
 * either end of it.
 *
 * The property this file guards hardest is not the rendering. It is that a
 * CEFR level here describes **content and never a person**: "Maya is A2" is
 * exactly the kind of figure the class boundary exists to keep off a
 * teacher's screen, and a level is the kind of thing that invites it.
 */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { CourseSyllabus } from "./CourseSyllabus.js";
import { cefrMapFor } from "../activities/cefr.js";
import { COURSES } from "../activities/courses/index.js";
import { LANGUAGES } from "../activities/languages/index.js";

afterEach(cleanup);

const french = COURSES.find((c) => c.slug === "fr");
const frenchIds = french?.activities.map((a) => a.id) ?? [];

function show(slug = "fr", label = "French", ids: readonly number[] = frenchIds) {
  render(<CourseSyllabus slug={slug} label={label} activityIds={ids} />);
}

describe("what a course covers", () => {
  it("lists a can-do statement for every activity the course contains", () => {
    show();

    const expected = cefrMapFor("fr").filter((e) => e.ids.some((id) => frenchIds.includes(id)));
    expect(expected.length, "nothing is mapped for French").toBeGreaterThan(5);
    for (const entry of expected) {
      expect(screen.getByText(entry.canDo)).toBeInTheDocument();
    }
  });

  it("groups them by level, lowest first", () => {
    show();

    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(headings.length).toBeGreaterThan(1);
    expect(headings[0]).toMatch(/^A1/);
  });

  /**
   * Speaking and listening are separated because the framework separates
   * them, and because merging them would overstate the course: hearing a
   * difference is not being able to produce it.
   */
  it("keeps listening apart from speaking", () => {
    show();

    expect(screen.getByRole("heading", { name: /listening/i })).toBeInTheDocument();
  });

  /**
   * Only what this course contains. The map for a language covers the bundled
   * ten and the course additions together, so a bundled-only deployment must
   * not advertise can-dos its learners cannot reach.
   */
  it("advertises nothing the bundled set does not contain", () => {
    const bundled = LANGUAGES.find((l) => l.slug === "fr");
    const bundledIds = bundled?.activities.map((a) => a.id) ?? [];
    show("fr", "French", bundledIds);

    const courseOnly = cefrMapFor("fr").filter(
      (e) => !e.ids.some((id) => bundledIds.includes(id)),
    );
    expect(courseOnly.length, "the course adds nothing to check against").toBeGreaterThan(0);
    for (const entry of courseOnly) {
      expect(screen.queryByText(entry.canDo), entry.canDo).toBeNull();
    }
  });

  /**
   * Hindi and Kannada get a syllabus too, and that is right rather than an
   * oversight: their ten activities parallel the shared block — greeting,
   * name, ordering, numbers — so the can-do statements describe them
   * accurately. What those two lack is per-sound advice, which is a different
   * thing entirely and comes from the scorer naming no syllables.
   */
  it("covers the languages whose content parallels the shared block", () => {
    const hindi = LANGUAGES.find((l) => l.slug === "hi");
    show("hi", "Hindi", hindi?.activities.map((a) => a.id) ?? []);

    expect(screen.getByRole("heading", { name: /what hindi covers/i })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(5);
  });

  /**
   * The empty branch, which is defensive rather than reachable today —
   * `cefr.test.ts` requires every shipped activity to be mapped. It exists for
   * the gap between adding a course's activities and extending the map, where
   * the honest answer is that our description is incomplete rather than that
   * the course is.
   */
  it("says so plainly when nothing is mapped, rather than rendering an empty list", () => {
    show("fr", "French", [9001, 9002]);

    expect(screen.getByText(/nothing is mapped/i)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("what it must never say", () => {
  /**
   * The load-bearing one. This component is given activity ids and no learner,
   * which is what makes the wrong version unbuildable rather than merely
   * discouraged — but the copy could still imply it.
   */
  it("describes the course and never a person's level", () => {
    show();

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\byou (are|have reached)\b/i);
    expect(text).not.toMatch(/\b(your|their|pupil'?s?|learner'?s?) level\b/i);
    expect(text).toMatch(/describes the course, never a pupil/i);
  });

  /**
   * And states its ceiling. A department buying for a B1 cohort should find
   * out here rather than in the first lesson, and a syllabus sheet claiming a
   * level this content cannot support is the overstatement that loses a school
   * after the sale rather than before it.
   */
  it("says the content stops at A2", () => {
    show();

    expect(document.body.textContent ?? "").toMatch(/nothing in this course goes beyond A2/i);
    expect(screen.queryByText(/\bB1\b.*things a learner can do/)).toBeNull();
  });
});
