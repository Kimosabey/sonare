/**
 * The skills collection — a learner's sound history, per language.
 *
 * One document per learner per language, so every merge is a single-document
 * update. Size is bounded by the domain caps: 400 syllables of 20 samples is
 * well inside Mongo's document limit.
 *
 * This is the data behind the claim no competitor makes — "‑ent is at 61, up
 * from 48 last week" — and it is also the input the scheduler will read, so
 * losing half of it degrades the product twice over.
 *
 * No TTL. The learner's own record.
 */

import { mergeAndSave, readAllFor, deleteAllFor, type VersionedDocument } from "./mergeStore.js";
import { getDb } from "../db.js";
import { mergeSkills, type Skill, type SkillState } from "../domain/merge.js";

export interface SkillDocument extends VersionedDocument {
  slug: string;
  skills: Skill[];
}

function documentId(learnerId: string, slug: string): string {
  return `${learnerId}:${slug}`;
}

/** Tolerant of a document written before a field existed. */
function fromDocument(doc: VersionedDocument): SkillState {
  const typed = doc as SkillDocument;
  return {
    slug: typeof typed.slug === "string" ? typed.slug : "",
    skills: Array.isArray(typed.skills) ? typed.skills : [],
  };
}

export async function readSkills(learnerId: string, slug: string): Promise<SkillState | null> {
  const db = await getDb();
  const doc = await db.collection<SkillDocument>("skills").findOne({ _id: documentId(learnerId, slug) });
  return doc === null ? null : fromDocument(doc);
}

export async function readAllSkills(learnerId: string): Promise<SkillState[]> {
  return readAllFor("skills", learnerId, fromDocument);
}

export async function mergeAndSaveSkills(learnerId: string, incoming: SkillState): Promise<SkillState> {
  return mergeAndSave<SkillState>({
    collection: "skills",
    id: documentId(learnerId, incoming.slug),
    learnerId,
    incoming,
    merge: mergeSkills,
    empty: { slug: incoming.slug, skills: [] },
    toFields: (state) => ({ slug: state.slug, skills: state.skills }),
    fromDocument,
  });
}

export async function deleteSkills(learnerId: string): Promise<void> {
  return deleteAllFor("skills", learnerId);
}
